"""Strict JSON/trace grading and side-effect-free native-tool mocks."""

import copy
import json
import math
import re

from cases import READ_TOOL, TOOL_DEFINITIONS
from safe_code import grade_code


class ContractError(Exception):
    pass


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ContractError("duplicate JSON key: " + key)
            result[key] = value
        return result

    def reject(value):
        raise ContractError("nonfinite JSON value: " + value)

    if not isinstance(text, str):
        raise ContractError("response content is not a string")
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=reject)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ContractError("invalid JSON: " + str(exc)) from exc


def validate(value, schema, path="$"):
    allowed_types = schema.get("type", [])
    if isinstance(allowed_types, str): allowed_types = [allowed_types]
    tests = {
        "object": lambda: type(value) is dict,
        "array": lambda: type(value) is list,
        "string": lambda: type(value) is str,
        "integer": lambda: type(value) is int,
        "number": lambda: type(value) is int or (type(value) is float and math.isfinite(value)),
        "boolean": lambda: type(value) is bool,
        "null": lambda: value is None,
    }
    if allowed_types and not any(t in tests and tests[t]() for t in allowed_types):
        raise ContractError(path + ": incorrect JSON type")
    if "enum" in schema and not any(type(value) is type(v) and value == v for v in schema["enum"]):
        raise ContractError(path + ": value outside enum")
    if type(value) is dict:
        properties = schema.get("properties", {})
        missing = set(schema.get("required", [])) - set(value)
        if missing: raise ContractError(path + ": missing fields " + ", ".join(sorted(missing)))
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            raise ContractError(path + ": unexpected fields")
        for key, child in value.items():
            if key in properties: validate(child, properties[key], path + "." + key)
    if type(value) is list:
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 10000):
            raise ContractError(path + ": invalid array length")
        if "items" in schema:
            for index, child in enumerate(value): validate(child, schema["items"], path + "[%d]" % index)
    if type(value) is str:
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 65536):
            raise ContractError(path + ": invalid string length")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise ContractError(path + ": pattern mismatch")
    if type(value) in (int, float):
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise ContractError(path + ": outside numeric bounds")


def same_json(left, right):
    if type(left) in (int, float) and type(right) in (int, float):
        try:
            return abs(left - right) < 1e-8
        except OverflowError:
            return False
    if type(left) is not type(right): return False
    if type(left) is dict:
        return set(left) == set(right) and all(same_json(left[k], right[k]) for k in left)
    if type(left) is list:
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


class MockTools:
    """No filesystem, shell, network, or real MCP calls are reachable here."""

    def __init__(self, case):
        self.case = case
        self.discovered = False
        self.trace = []
        self.reads = []
        self.violations = []
        self.ids = set()

    @staticmethod
    def result(text, error=False):
        return {"content": [{"type": "text", "text": text}], "isError": error}

    def dispatch(self, tool_call):
        receipt = {"tool_call": copy.deepcopy(tool_call)}
        self.trace.append(receipt)
        try:
            if type(tool_call) is not dict or tool_call.get("type") != "function":
                raise ContractError("invalid function tool-call envelope")
            call_id = tool_call.get("id")
            if not isinstance(call_id, str) or not call_id or call_id in self.ids:
                raise ContractError("missing or reused tool-call id")
            self.ids.add(call_id)
            function = tool_call.get("function")
            if type(function) is not dict: raise ContractError("missing function payload")
            name = function.get("name")
            schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in TOOL_DEFINITIONS}
            if name not in schemas: raise ContractError("unavailable tool: " + str(name))
            arguments = strict_json(function.get("arguments"))
            validate(arguments, schemas[name])
            receipt.update({"name": name, "arguments": arguments})
            if name == "search_tools":
                if not arguments["query"].strip() or len(arguments["query"]) > 256:
                    raise ContractError("search query must be a nonempty bounded string")
                if arguments.get("offset", 0) != 0:
                    raise ContractError("mock tool inventory has only its first page")
                self.discovered = True
                output = {"tools": [copy.deepcopy(READ_TOOL)], "total": 1,
                          "nextOffset": None, "truncated": False,
                          "servers": [{"id": "bench-files", "connected": True}]}
            else:
                if not self.discovered: raise ContractError("execute_tool before discovery")
                if arguments["server"] != "bench-files" or arguments["name"] != "read_text_file":
                    raise ContractError("unavailable server or non-read-only operation")
                validate(arguments["arguments"], READ_TOOL["inputSchema"])
                path = arguments["arguments"]["path"]
                if path not in self.case.get("files", {}):
                    raise ContractError("unrelated or unavailable synthetic path: " + path)
                self.reads.append(path)
                if self.case["grader"] == "tool_recovery" and len(self.reads) == 1:
                    output = self.result(json.dumps({"error": "timeout", "readOnly": True,
                                                    "sideEffects": False}), error=True)
                else:
                    output = self.result(self.case["files"][path])
            receipt["result"] = output
            return output
        except ContractError as exc:
            reason = str(exc)
            self.violations.append(reason)
            output = self.result(json.dumps({"error": "blocked_by_mock", "reason": reason}), error=True)
            receipt["result"] = output
            return output

    def grade(self):
        if self.violations:
            return {"status": "fail", "reason": "tool contract or access violation",
                    "violations": self.violations}
        if not self.discovered:
            return {"status": "fail", "reason": "required tool discovery never occurred"}
        expected = self.case["read_order"]
        if self.case["grader"] == "tool_recovery" or self.case.get("strict_read_order"):
            correct = self.reads == expected
        else:
            unique_order = []
            for path in self.reads:
                if path not in unique_order: unique_order.append(path)
            correct = unique_order == expected
        if not correct:
            return {"status": "fail", "reason": "required real tool-read sequence missing or wrong",
                    "expected_read_order": expected, "actual_reads": self.reads}
        return {"status": "pass"}


def grade(case, final_text, mock=None, unexpected_tool_calls=False):
    if unexpected_tool_calls:
        return {"status": "fail", "reason": "tools called in a text-only case"}
    if case.get("tools"):
        if mock is None: return {"status": "fail", "reason": "no tool trace exists"}
        trace_result = mock.grade()
        if trace_result["status"] != "pass": return trace_result
    try:
        value = strict_json(final_text)
        validate(value, case["schema"])
    except ContractError as exc:
        return {"status": "fail", "reason": "output contract: " + str(exc)}
    if case["category"] == "coding":
        return grade_code(case, value["code"])
    comparison_value = value
    if case["id"] == "H07":
        # Harakat and initial alef/hamza spelling variants do not change the day.
        comparison_value = dict(value)
        for key in ("اليوم", "موعد_التقرير"):
            comparison_value[key] = re.sub(r"[\u064b-\u065f\u0670]", "", value[key]).translate(str.maketrans("أإآ", "ااا"))
    if same_json(comparison_value, case["expected"]):
        return {"status": "pass"}
    return {"status": "fail", "reason": "incorrect structured answer",
            "expected": case["expected"], "actual": value}
