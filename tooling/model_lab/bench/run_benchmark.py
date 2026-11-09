#!/usr/bin/env python3
"""Run bounded, synthetic local-model checks over an OpenAI-compatible API.

Only loopback HTTP(S) is permitted. Model-generated code is interpreted by an
explicit small AST evaluator; tool calls are in-memory read-only mocks.
"""

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from cases import CASES, DEFAULT_MODEL, DEFAULT_SYSTEM, SUITE_VERSION, TOOL_DEFINITIONS, fixture_hash
from grading import MockTools, grade
import agent_cases


class TransportError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TransportError("redirect refused; endpoint must remain on the selected loopback origin")


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def validate_base_url(base_url):
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("only an explicit localhost/127.0.0.1/::1 endpoint is allowed")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.params:
        raise ValueError("endpoint credentials, query strings, parameters, and fragments are not supported")
    if parsed.path.rstrip("/") != "/v1":
        raise ValueError("base URL must end in /v1")
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535: raise ValueError("invalid port")
    except ValueError as exc:
        raise ValueError("invalid endpoint port") from exc
    return base_url.rstrip("/")


class LocalAPI:
    def __init__(self, base_url, api_key=None):
        self.base_url = validate_base_url(base_url)
        self.api_key = api_key
        # Do not route loopback data through environment-configured outbound proxies.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, payload=None, timeout=30):
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        old_handler = None
        can_alarm = hasattr(signal, "setitimer") and hasattr(signal, "SIGALRM")
        def alarm_handler(signum, frame):
            raise TimeoutError("absolute request deadline exceeded")
        try:
            if can_alarm:
                old_handler = signal.signal(signal.SIGALRM, alarm_handler)
                signal.setitimer(signal.ITIMER_REAL, max(0.1, timeout))
            with self.opener.open(request, timeout=max(0.1, timeout)) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise TransportError("API response exceeds 4 MiB")
            value = json.loads(raw.decode("utf-8"))
            if type(value) is not dict:
                raise TransportError("API returned a non-object JSON response")
            return value
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(1500).decode("utf-8", "replace")
            except Exception:
                detail = "error body unavailable"
            raise TransportError("HTTP %s: %s" % (exc.code, detail)) from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise TransportError(type(exc).__name__ + ": " + str(exc)) from exc
        finally:
            if can_alarm and old_handler is not None:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old_handler)


def bounded_content(message):
    content = message.get("content")
    if content is None: return ""
    if type(content) is str: return content
    if type(content) is list and all(type(x) is dict and x.get("type") == "text" and type(x.get("text")) is str for x in content):
        return "".join(x["text"] for x in content)
    raise TransportError("unsupported assistant content shape")


def make_payload(args, messages, case):
    payload = {"model": args.model, "messages": messages, "stream": False,
               "temperature": args.temperature, "top_p": 1,
               "max_tokens": args.max_tokens}
    payload.update(getattr(args, "generation_profile", {}))
    if not args.omit_reasoning:
        payload["reasoning_effort"] = "none"
    if args.seed is not None:
        payload["seed"] = args.seed
    if case.get("tools"):
        payload.update({"tools": TOOL_DEFINITIONS, "tool_choice": "auto", "parallel_tool_calls": False})
    elif args.constrained_json:
        payload["response_format"] = {"type": "json_schema", "json_schema": {
            "name": "noiee_" + case["id"], "strict": True, "schema": case["schema"]}}
    return payload


def run_case(api, args, case, system_prompt, run_deadline, out_dir):
    started = time.monotonic()
    deadline = min(run_deadline, started + args.case_timeout)
    messages = [{"role": "system", "content": system_prompt}] + copy.deepcopy(case["messages"])
    mock = MockTools(case) if case.get("tools") else None
    receipt = {"id": case["id"], "name": case["name"], "category": case["category"],
               "started_at": utc_now(), "status": "running", "synthetic": True,
               "output_schema": case["schema"], "messages": copy.deepcopy(messages),
               "source_sha256": source_hashes(),
               "rubric": {"answer": "strict JSON schema and bounded code assertions" if case["category"] == "coding" else "strict JSON schema and exact reference values",
                          "tool_trace": "required discovery, allowed operation/arguments, observed read sequence" if case.get("tools") else "no tools allowed"},
               "requests": [], "tool_trace": [], "grading": None}
    path = out_dir / (case["id"] + ".json")
    atomic_json(path, receipt)
    result = None
    try:
        for round_number in range(args.max_rounds):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result = {"status": "timeout", "reason": "per-case or run deadline reached"}
                break
            payload = make_payload(args, messages, case)
            serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False)
            if len(serialized.encode("utf-8")) > 100000:
                result = {"status": "harness_limit", "reason": "request exceeds 100000 UTF-8 bytes; no truncation was performed"}
                break
            request_record = {"round": round_number + 1, "started_at": utc_now(),
                              "payload_sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
                              "request_bytes": len(serialized.encode("utf-8")),
                              "status": "pending"}
            receipt["requests"].append(request_record)
            atomic_json(path, receipt)
            request_started = time.monotonic()
            response = api.request("/chat/completions", payload, timeout=remaining)
            request_record["elapsed_seconds"] = round(time.monotonic() - request_started, 4)
            request_record["status"] = "received"
            request_record["usage"] = response.get("usage")
            request_record["response_model"] = response.get("model")
            choices = response.get("choices")
            if type(choices) is not list or not choices or type(choices[0]) is not dict:
                raise TransportError("chat completion has no valid choice")
            choice = choices[0]
            message = choice.get("message")
            if type(message) is not dict:
                raise TransportError("chat completion has no assistant message")
            finish = choice.get("finish_reason")
            request_record["finish_reason"] = finish
            reasoning = message.get("reasoning_content", message.get("reasoning", ""))
            request_record["reasoning_returned_characters"] = len(reasoning) if isinstance(reasoning, str) else None
            assistant = {"role": "assistant", "content": bounded_content(message)}
            calls = message.get("tool_calls") or []
            if calls:
                if type(calls) is not list:
                    raise TransportError("tool_calls is not an array")
                assistant["tool_calls"] = calls
            messages.append(assistant)
            receipt["messages"] = copy.deepcopy(messages)
            atomic_json(path, receipt)
            usage = response.get("usage") or {}
            prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
            if isinstance(prompt_tokens, int) and prompt_tokens + args.max_tokens > args.context_limit:
                result = {"status": "context_budget", "reason": "reported prompt tokens plus requested output exceed declared context limit",
                          "prompt_tokens": prompt_tokens, "declared_context_limit": args.context_limit}
                break
            if finish == "length":
                result = {"status": "output_limit", "reason": "generation reached max_tokens; no correctness score assigned"}
                break
            # A plausible answer is not proof of a completed generation. Validate
            # the terminal contract before grading text or dispatching mock tools.
            if finish not in ("stop", "tool_calls"):
                raise TransportError("missing or unsupported completion finish reason")
            if finish == "tool_calls" and not calls:
                raise TransportError("tool-call finish without tool calls")
            if finish == "stop" and calls:
                raise TransportError("tool calls without a tool-call finish")
            if calls:
                if not mock:
                    result = grade(case, assistant["content"], unexpected_tool_calls=True)
                    break
                if len(calls) != 1:
                    result = {"status": "fail", "reason": "multiple tool calls in one response; none were dispatched"}
                    break
                tool_result = mock.dispatch(calls[0])
                call_id = calls[0].get("id") if isinstance(calls[0], dict) else None
                if not isinstance(call_id, str) or not call_id:
                    result = {"status": "fail", "reason": "missing native tool-call id"}
                    break
                messages.append({"role": "tool", "tool_call_id": call_id,
                                 "content": json.dumps(tool_result, ensure_ascii=False, allow_nan=False)})
                receipt["messages"] = copy.deepcopy(messages)
                receipt["tool_trace"] = copy.deepcopy(mock.trace)
                atomic_json(path, receipt)
                if mock.violations:
                    result = mock.grade()
                    break
                continue
            result = grade(case, assistant["content"], mock=mock)
            break
        if result is None:
            result = {"status": "harness_limit", "reason": "maximum conversation rounds reached"}
    except TransportError as exc:
        result = {"status": "transport_error", "reason": str(exc)}
        if receipt["requests"] and receipt["requests"][-1]["status"] == "pending":
            receipt["requests"][-1].update({"status": "transport_error", "error": str(exc)})
    except KeyboardInterrupt:
        result = {"status": "interrupted", "reason": "run interrupted; no completion inferred"}
    except Exception as exc:
        result = {"status": "harness_error", "reason": type(exc).__name__ + ": " + str(exc)}
    receipt.update({"status": result["status"], "grading": result,
                    "finished_at": utc_now(), "elapsed_seconds": round(time.monotonic() - started, 4),
                    "tool_trace": copy.deepcopy(mock.trace) if mock else []})
    atomic_json(path, receipt)
    return {"id": case["id"], "name": case["name"], "category": case["category"],
            "status": result["status"], "reason": result.get("reason"),
            "elapsed_seconds": receipt["elapsed_seconds"], "receipt": path.name,
            "receipt_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def source_hashes():
    root = Path(__file__).resolve().parent
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.glob("*.py"))}


def category_scores(results):
    scores = {}
    for category in sorted({row["category"] for row in results}):
        rows = [row for row in results if row["category"] == category]
        passed = sum(row["status"] == "pass" for row in rows)
        scorable = sum(row["status"] in {"pass", "fail"} for row in rows)
        scores[category] = {"passed": passed, "scorable": scorable, "selected": len(rows),
                            "pass_rate": passed / scorable if scorable else None,
                            "coverage": scorable / len(rows)}
    return scores


def summary_counts(results):
    counts = {}
    for result in results:
        counts[result["status"]] = counts.get(result["status"], 0) + 1
    return counts


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:1234/v1")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--source-model-id", default="unknown", help="Verified underlying artifact identity; use unknown if unverified")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--system-prompt-file", help="Optional exact baseline/candidate app prompt; never inferred automatically")
    parser.add_argument("--label", default="baseline")
    parser.add_argument("--suite", choices=["legacy", "agent"], default="legacy")
    parser.add_argument("--case", action="append", dest="case_ids", choices=[case["id"] for case in CASES + agent_cases.CASES])
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--case-timeout", type=float, default=180)
    parser.add_argument("--run-timeout", type=float, default=1200)
    parser.add_argument("--max-rounds", type=int, default=7)
    parser.add_argument("--context-limit", type=int, default=8192)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--generation-profile", help="JSON file of bounded sampling-only overrides; cannot change model, messages or tools")
    parser.add_argument("--seed", type=int, default=None, help="Opt in only if the endpoint accepts seed; record support separately")
    parser.add_argument("--omit-reasoning", action="store_true", help="Omit reasoning_effort only when endpoint rejects it")
    parser.add_argument("--constrained-json", action="store_true", help="Use response_format json_schema on text/code cases; changes the experiment")
    parser.add_argument("--api-key-env", default="NOIEE_LOCAL_API_KEY", help="Optional environment variable name; key is never saved")
    args = parser.parse_args(argv)
    available = CASES if args.suite == "legacy" else agent_cases.CASES
    if args.case_ids and set(args.case_ids) - {c["id"] for c in available}:
        parser.error("selected case does not belong to selected suite")
    if not 128 <= args.max_tokens <= 1024: parser.error("max-tokens must be 128..1024")
    if not 1 <= args.case_timeout <= 180: parser.error("case-timeout must be 1..180 seconds")
    if not 1 <= args.run_timeout <= 1200: parser.error("run-timeout must be 1..1200 seconds")
    if not 1 <= args.max_rounds <= 8: parser.error("max-rounds must be 1..8")
    if not 2048 <= args.context_limit <= 8192: parser.error("context-limit must be 2048..8192")
    if not 0 <= args.temperature <= 1: parser.error("temperature must be 0..1")
    args.generation_profile_source = args.generation_profile
    if args.generation_profile:
        try:
            profile = json.loads(Path(args.generation_profile).read_text(encoding="utf-8"))
            allowed = {"temperature": (0, 1), "top_p": (0, 1), "top_k": (1, 1000), "min_p": (0, 1), "presence_penalty": (-2, 2), "frequency_penalty": (-2, 2)}
            if type(profile) is not dict or not profile or set(profile) - set(allowed):
                raise ValueError("profile must contain only supported sampling keys")
            for key, value in profile.items():
                if type(value) not in {int, float} or not allowed[key][0] <= value <= allowed[key][1] or key == "top_k" and type(value) is not int:
                    raise ValueError("invalid profile value: " + key)
            args.generation_profile = profile
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
    else:
        args.generation_profile = {}
    try: args.base_url = validate_base_url(args.base_url)
    except ValueError as exc: parser.error(str(exc))
    return args


def main(argv=None):
    args = parse_args(argv)
    os.umask(0o077)
    out_dir = Path(args.output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if any(out_dir.iterdir()):
        print("Output directory is not empty; use a new run directory to preserve receipts.", file=sys.stderr)
        return 2
    system_prompt = Path(args.system_prompt_file).read_text(encoding="utf-8") if args.system_prompt_file else DEFAULT_SYSTEM
    if len(system_prompt) > 24000:
        print("System prompt exceeds the bounded 24000-character limit.", file=sys.stderr)
        return 2
    suite_cases = CASES if args.suite == "legacy" else agent_cases.CASES
    selected = [case for case in suite_cases if not args.case_ids or case["id"] in args.case_ids]
    started = time.monotonic()
    deadline = started + args.run_timeout
    manifest = {
        "suite": SUITE_VERSION if args.suite == "legacy" else agent_cases.SUITE_VERSION,
        "fixture_sha256": fixture_hash() if args.suite == "legacy" else agent_cases.fixture_hash(), "synthetic": True,
        "evidence_kind": "model_transport", "source_sha256": source_hashes(),
        "scope": "Local-model transport regression with bounded code interpretation and in-memory tool mocks. Not end-to-end app/UI testing or a broad capability benchmark.",
        "started_at": utc_now(), "label": args.label, "status": "preflight",
        "model": args.model, "verified_source_model_id": args.source_model_id,
        "base_url": args.base_url,
        "system_prompt_sha256": hashlib.sha256(system_prompt.encode("utf-8")).hexdigest(),
        "system_prompt_source": str(Path(args.system_prompt_file).resolve()) if args.system_prompt_file else "bundled_minimal_harness_prompt",
        "generation": {"temperature": args.temperature, "top_p": 1, "max_tokens": args.max_tokens,
                       "reasoning_effort": None if args.omit_reasoning else "none", "seed": args.seed,
                       "constrained_json": args.constrained_json, **args.generation_profile},
        "generation_profile_source": args.generation_profile_source,
        "limits": {"case_seconds": args.case_timeout, "run_seconds": args.run_timeout,
                   "rounds": args.max_rounds, "declared_context_tokens": args.context_limit},
        "notes": ["No prompt/history truncation is performed by the harness.",
                  "The API may ignore sampling options; recorded requests do not prove support.",
                  "No model-generated shell command or Python code is executed on the host.",
                  "Hidden reasoning text, if returned despite reasoning_effort=none, is not saved.",
                  "Tool mocks exercise native search_tools/execute_tool envelopes but not the app's actual MCP transport."],
        "results": [],
    }
    manifest_path = out_dir / "results.json"
    atomic_json(manifest_path, manifest)
    (out_dir / "system-prompt.txt").write_text(system_prompt, encoding="utf-8")
    api = LocalAPI(args.base_url, os.environ.get(args.api_key_env))
    try:
        models = api.request("/models", timeout=min(15, max(0.1, deadline - time.monotonic())))
        rows = models.get("data")
        ids = [row.get("id") for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
        manifest["preflight"] = {"endpoint_reachable": True, "selected_model_listed": args.model in ids}
        if args.model not in ids:
            raise TransportError("selected exact model ID was not returned by /models; no replacement selected")
    except TransportError as exc:
        manifest.update({"status": "blocked", "preflight_error": str(exc), "finished_at": utc_now()})
        manifest["results"] = [{"id": case["id"], "category": case["category"], "status": "not_run",
                                "reason": "preflight blocked"} for case in selected]
        manifest["counts"] = summary_counts(manifest["results"])
        manifest["category_scores"] = category_scores(manifest["results"])
        atomic_json(manifest_path, manifest)
        print(json.dumps({"status": "blocked", "reason": str(exc), "results": str(manifest_path)}), flush=True)
        return 2
    manifest["status"] = "running"
    atomic_json(manifest_path, manifest)
    stop_reason = None
    for case in selected:
        if stop_reason or time.monotonic() >= deadline:
            manifest["results"].append({"id": case["id"], "category": case["category"], "status": "not_run",
                                        "reason": stop_reason or "full-run deadline reached"})
            continue
        result = run_case(api, args, case, system_prompt, deadline, out_dir)
        manifest["results"].append(result)
        manifest["counts"] = summary_counts(manifest["results"])
        manifest["category_scores"] = category_scores(manifest["results"])
        atomic_json(manifest_path, manifest)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if result["status"] in {"transport_error", "timeout", "interrupted", "harness_error"}:
            stop_reason = "stopped after " + result["status"] + "; no blind retry of pending generation"
    counts = summary_counts(manifest["results"])
    scorable = counts.get("pass", 0) + counts.get("fail", 0)
    manifest.update({"status": "complete" if scorable == len(selected) else "partial",
                     "counts": counts, "category_scores": category_scores(manifest["results"]),
                     "source_unchanged": manifest["source_sha256"] == source_hashes(),
                     "scorable_cases": scorable,
                     "passed_scorable_cases": counts.get("pass", 0),
                     "finished_at": utc_now(), "elapsed_seconds": round(time.monotonic() - started, 4)})
    if not manifest["source_unchanged"]:
        manifest.update(status="invalidated", invalidation_reason="harness source changed during run; scores are not comparable")
    atomic_json(manifest_path, manifest)
    print(json.dumps({"status": manifest["status"], "counts": counts, "results": str(manifest_path)}), flush=True)
    if manifest["status"] in {"partial", "invalidated"}: return 3
    return 1 if counts.get("fail", 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
