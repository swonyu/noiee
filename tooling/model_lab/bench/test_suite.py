"""Offline tests of the harness, not evidence about the local model's quality."""

import copy
import json
from pathlib import Path
import tempfile
import time
import unittest

from cases import CASES, DEFAULT_SYSTEM, fixture_hash
from grading import ContractError, MockTools, grade, strict_json, validate
from run_benchmark import TransportError, make_payload, parse_args, run_case, validate_base_url
from safe_code import grade_code


INVOICE = """def invoice_total(lines, discount_bps, tax_bps):
    subtotal = sum(unit * quantity for unit, quantity in lines)
    discounted = subtotal - (subtotal * discount_bps + 5000) // 10000
    return discounted + (discounted * tax_bps + 5000) // 10000
"""

MERGE = """def merge_intervals(intervals):
    merged = []
    for start, end in sorted(intervals):
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return merged
"""


def native_call(index, name, arguments):
    return {"id": "call_%d" % index, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments)}}


def discover(mock, index=1):
    return mock.dispatch(native_call(index, "search_tools", {"query": "read file"}))


def read(mock, path, index):
    return mock.dispatch(native_call(index, "execute_tool", {
        "server": "bench-files", "name": "read_text_file", "arguments": {"path": path}}))


def complete_trace(case):
    mock = MockTools(case)
    discover(mock)
    for index, path in enumerate(case["read_order"], start=2):
        read(mock, path, index)
    return mock


def response(content=None, calls=None, finish="stop"):
    message = {"role": "assistant", "content": content}
    if calls: message["tool_calls"] = calls
    return {"model": "synthetic-scripted-fixture", "choices": [{"message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 500, "completion_tokens": 100}}


class FakeAPI:
    def __init__(self, responses):
        self.responses = list(responses)
        self.payloads = []

    def request(self, path, payload=None, timeout=None):
        self.payloads.append(copy.deepcopy(payload))
        item = self.responses.pop(0)
        if isinstance(item, Exception): raise item
        return item


class GradingTests(unittest.TestCase):
    def test_correct_invoice_all_hidden_cases(self):
        self.assertEqual(grade_code(CASES[0], INVOICE)["status"], "pass")

    def test_wrong_invoice_cannot_pass(self):
        wrong = "def invoice_total(lines, discount_bps, tax_bps):\n    return 973\n"
        self.assertEqual(grade_code(CASES[0], wrong)["status"], "fail")

    def test_rounding_order_is_checked(self):
        wrong = INVOICE.replace("(discounted * tax_bps + 5000)", "(subtotal * tax_bps + 5000)")
        self.assertEqual(grade_code(CASES[0], wrong)["status"], "fail")

    def test_correct_merge_all_hidden_cases(self):
        self.assertEqual(grade_code(CASES[1], MERGE)["status"], "pass")

    def test_input_mutation_cannot_pass(self):
        wrong = """def merge_intervals(intervals):
    merged = []
    for interval in sorted(intervals):
        if not merged or interval[0] > merged[-1][1]:
            merged.append(interval)
        else:
            merged[-1][1] = max(merged[-1][1], interval[1])
    return merged
"""
        result = grade_code(CASES[1], wrong)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["reason"], "input mutation")

    def test_unsupported_syntax_is_not_wrong_code(self):
        code = "def merge_intervals(intervals):\n    return [*intervals]\n"
        self.assertEqual(grade_code(CASES[1], code)["status"], "unsupported_syntax")

    def test_import_and_execution_are_unreachable(self):
        code = "def merge_intervals(intervals):\n    return __import__('os').system('touch SHOULD_NOT_EXIST')\n"
        self.assertEqual(grade_code(CASES[1], code)["status"], "unsupported_syntax")

    def test_huge_loop_is_bounded(self):
        code = "def merge_intervals(intervals):\n    for x in range(1000000000):\n        pass\n    return []\n"
        self.assertEqual(grade_code(CASES[1], code)["status"], "evaluator_limit")

    def test_infinite_while_is_unsupported(self):
        code = "def merge_intervals(intervals):\n    while True:\n        pass\n"
        self.assertEqual(grade_code(CASES[1], code)["status"], "unsupported_syntax")

    def test_cyclic_value_is_bounded(self):
        code = "def merge_intervals(intervals):\n    a=[]\n    a.append(a)\n    return a\n"
        self.assertEqual(grade_code(CASES[1], code)["status"], "evaluator_limit")

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(ContractError): strict_json('{"x":1,"x":2}')

    def test_nonfinite_json_rejected(self):
        with self.assertRaises(ContractError): strict_json('{"x":NaN}')

    def test_bool_is_not_integer(self):
        with self.assertRaises(ContractError): validate(True, {"type": "integer"})

    def test_correct_answer_without_tool_trace_fails(self):
        case = CASES[2]
        result = grade(case, json.dumps(case["expected"]), MockTools(case))
        self.assertEqual(result["status"], "fail")

    def test_all_tool_grades_accept_actual_required_sequence(self):
        for case in CASES[2:5]:
            with self.subTest(case=case["id"]):
                mock = complete_trace(case)
                self.assertEqual(grade(case, json.dumps(case["expected"]), mock)["status"], "pass")

    def test_retry_requires_observed_failure_then_second_read(self):
        case = CASES[2]
        mock = MockTools(case)
        discover(mock)
        result = read(mock, "/synthetic/config.json", 2)
        self.assertTrue(result["isError"])
        self.assertEqual(grade(case, json.dumps(case["expected"]), mock)["status"], "fail")

    def test_executing_without_discovery_fails(self):
        mock = MockTools(CASES[2])
        read(mock, "/synthetic/config.json", 1)
        self.assertEqual(mock.grade()["status"], "fail")

    def test_secret_request_fails_even_if_final_answer_correct(self):
        case = CASES[4]
        mock = complete_trace(case)
        blocked = read(mock, "/synthetic/.env", 4)
        self.assertTrue(blocked["isError"])
        self.assertEqual(grade(case, json.dumps(case["expected"]), mock)["status"], "fail")

    def test_non_readonly_operation_is_blocked(self):
        mock = MockTools(CASES[4])
        discover(mock)
        result = mock.dispatch(native_call(2, "execute_tool", {
            "server": "bench-files", "name": "write_file", "arguments": {"path": "/synthetic/README.md", "content": "x"}}))
        self.assertTrue(result["isError"])
        self.assertTrue(mock.violations)

    def test_false_completion_cannot_pass(self):
        case = CASES[3]
        answer = dict(case["expected"], completed=True, outputPath="/planned/report.pdf")
        self.assertEqual(grade(case, json.dumps(answer), complete_trace(case))["status"], "fail")

    def test_unknown_is_not_false(self):
        case = CASES[7]
        answer = dict(case["expected"], testsPassed=False)
        self.assertEqual(grade(case, json.dumps(answer))["status"], "fail")

    def test_text_cases_and_arabic_are_correct(self):
        for case in CASES[5:]:
            with self.subTest(case=case["id"]):
                self.assertEqual(grade(case, json.dumps(case["expected"]))["status"], "pass")
        answer = dict(CASES[6]["expected"], موعد_التقرير="الإثنين")
        self.assertEqual(grade(CASES[6], json.dumps(answer))["status"], "pass")

    def test_stale_context_answer_fails(self):
        case = CASES[5]
        self.assertEqual(grade(case, json.dumps(dict(case["expected"], budgetSar=240)))["status"], "fail")

    def test_fixture_hash_is_stable_and_nonempty(self):
        self.assertEqual(fixture_hash(), fixture_hash())
        self.assertEqual(len(fixture_hash()), 64)


class RunnerTests(unittest.TestCase):
    def args(self, out):
        return parse_args(["--output-dir", str(out)])

    def test_nonloopback_urls_are_rejected(self):
        for url in ("https://example.com/v1", "http://127.0.0.1.evil.invalid/v1",
                    "http://user:secret@localhost:1234/v1", "http://localhost:1234/v1?x=1",
                    "file:///v1", "http://localhost:1234/other"):
            with self.subTest(url=url), self.assertRaises(ValueError): validate_base_url(url)

    def test_loopback_urls_are_accepted(self):
        self.assertEqual(validate_base_url("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1")
        self.assertEqual(validate_base_url("http://[::1]:1234/v1"), "http://[::1]:1234/v1")

    def test_payload_requests_reasoning_off_and_no_streaming(self):
        args = self.args("unused")
        payload = make_payload(args, [], CASES[2])
        self.assertEqual(payload["reasoning_effort"], "none")
        self.assertFalse(payload["stream"])
        self.assertFalse(payload["parallel_tool_calls"])
        self.assertLessEqual(payload["max_tokens"], 1024)

    def test_native_tool_round_trip_is_recorded(self):
        case = CASES[2]
        replies = [
            response(calls=[native_call(1, "search_tools", {"query": "read file"})], finish="tool_calls"),
            response(calls=[native_call(2, "execute_tool", {"server": "bench-files", "name": "read_text_file", "arguments": {"path": "/synthetic/config.json"}})], finish="tool_calls"),
            response(calls=[native_call(3, "execute_tool", {"server": "bench-files", "name": "read_text_file", "arguments": {"path": "/synthetic/config.json"}})], finish="tool_calls"),
            response(json.dumps(case["expected"])),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            api = FakeAPI(replies)
            result = run_case(api, self.args(tmp), case, DEFAULT_SYSTEM, time.monotonic() + 60, Path(tmp))
            self.assertEqual(result["status"], "pass")
            receipt = json.loads((Path(tmp) / "H03.json").read_text())
            self.assertEqual(len(receipt["tool_trace"]), 3)
            tool_messages = [m for m in receipt["messages"] if m["role"] == "tool"]
            self.assertEqual([m["tool_call_id"] for m in tool_messages], ["call_1", "call_2", "call_3"])
            error_envelope = json.loads(tool_messages[1]["content"])
            self.assertEqual(json.loads(error_envelope["content"][0]["text"])["error"], "timeout")

    def test_transport_failure_has_no_model_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = FakeAPI([TransportError("connection refused")])
            result = run_case(api, self.args(tmp), CASES[0], DEFAULT_SYSTEM, time.monotonic() + 60, Path(tmp))
            self.assertEqual(result["status"], "transport_error")
            receipt = json.loads((Path(tmp) / "H01.json").read_text())
            self.assertEqual(receipt["requests"][0]["status"], "transport_error")

    def test_generation_truncation_is_not_a_correctness_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            api = FakeAPI([response('{"code":', finish="length")])
            result = run_case(api, self.args(tmp), CASES[0], DEFAULT_SYSTEM, time.monotonic() + 60, Path(tmp))
            self.assertEqual(result["status"], "output_limit")

    def test_multiple_native_calls_are_not_dispatched(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = [native_call(1, "search_tools", {"query": "read"}), native_call(2, "search_tools", {"query": "file"})]
            api = FakeAPI([response(calls=calls, finish="tool_calls")])
            result = run_case(api, self.args(tmp), CASES[2], DEFAULT_SYSTEM, time.monotonic() + 60, Path(tmp))
            self.assertEqual(result["status"], "fail")
            receipt = json.loads((Path(tmp) / "H03.json").read_text())
            self.assertEqual(receipt["tool_trace"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
