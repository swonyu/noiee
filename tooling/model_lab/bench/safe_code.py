"""A deliberately small AST interpreter; never compiles/evals/execs model code.

This is a task evaluator, not a general Python sandbox. Only constructed primitive
values and explicitly implemented operations are reachable by interpreted code.
"""

import ast
import copy
import math


class UnsupportedSyntax(Exception):
    pass


class EvaluationLimit(Exception):
    pass


class CodeError(Exception):
    pass


class Returned(Exception):
    def __init__(self, value):
        self.value = value


class Broke(Exception):
    pass


class Continued(Exception):
    pass


ALLOWED_NODES = {
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Assign,
    ast.AugAssign, ast.For, ast.If, ast.Expr, ast.Pass, ast.Break, ast.Continue,
    ast.Name, ast.Load, ast.Store, ast.Constant, ast.List, ast.Tuple, ast.Dict,
    ast.Subscript, ast.Slice, ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div,
    ast.FloorDiv, ast.Mod, ast.UnaryOp, ast.UAdd, ast.USub, ast.Not, ast.BoolOp,
    ast.And, ast.Or, ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt,
    ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot, ast.Call, ast.Attribute,
    ast.ListComp, ast.GeneratorExp, ast.comprehension, ast.IfExp, ast.keyword,
}


class Interpreter:
    MAX_ITEMS = 1024

    def __init__(self, code, function_name, expected_arguments):
        if not isinstance(code, str) or len(code) > 12000:
            raise EvaluationLimit("code exceeds 12000 characters")
        try:
            tree = ast.parse(code, mode="exec")
        except (SyntaxError, RecursionError) as exc:
            raise CodeError("invalid Python syntax: " + str(exc)) from exc
        nodes = list(ast.walk(tree))
        if len(nodes) > 500:
            raise EvaluationLimit("code exceeds 500 AST nodes")
        for node in nodes:
            if type(node) not in ALLOWED_NODES:
                raise UnsupportedSyntax("unsupported AST node: " + type(node).__name__)
            if isinstance(node, (ast.Name, ast.arg)):
                name = node.id if isinstance(node, ast.Name) else node.arg
                if name.startswith("__"):
                    raise UnsupportedSyntax("dunder identifiers are not supported")
            if isinstance(node, ast.Attribute) and node.attr not in {"append", "copy"}:
                raise UnsupportedSyntax("only list.append and list.copy are supported")
            if isinstance(node, ast.Call) and not isinstance(node.func, (ast.Name, ast.Attribute)):
                raise UnsupportedSyntax("only named pure functions and list methods are supported")
            if isinstance(node, ast.comprehension) and node.is_async:
                raise UnsupportedSyntax("async comprehension")
        body = [node for node in tree.body if not (
            isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str))]
        if len(body) != 1 or not isinstance(body[0], ast.FunctionDef):
            raise UnsupportedSyntax("return exactly one function and no other top-level code")
        self.function = body[0]
        if self.function.name != function_name:
            raise CodeError("wrong function name")
        args = self.function.args
        if args.posonlyargs or args.vararg or args.kwarg or args.kwonlyargs or self.function.decorator_list:
            raise UnsupportedSyntax("decorators or special function arguments")
        if [arg.arg for arg in args.args] != expected_arguments:
            raise CodeError("function argument names/order differ from requested interface")
        self.fuel = 0
        self.depth = 0

    def tick(self):
        self.fuel -= 1
        if self.fuel < 0:
            raise EvaluationLimit("operation budget exhausted")

    def bound(self, value, depth=0):
        if depth > 24:
            raise EvaluationLimit("value nesting exceeds 24")
        if value is None or type(value) is bool:
            return value
        if type(value) is int:
            if value.bit_length() > 63:
                raise EvaluationLimit("integer exceeds 63-bit magnitude")
            return value
        if type(value) is float:
            if not math.isfinite(value) or abs(value) > 1e18:
                raise EvaluationLimit("nonfinite or oversized number")
            return value
        if type(value) is str:
            if len(value) > 12000:
                raise EvaluationLimit("string too large")
            return value
        if type(value) in (list, tuple, dict):
            if len(value) > self.MAX_ITEMS:
                raise EvaluationLimit("collection exceeds 1024 items")
            children = list(value.keys()) + list(value.values()) if type(value) is dict else value
            for child in children:
                self.bound(child, depth + 1)
            return value
        raise UnsupportedSyntax("unreachable value type: " + type(value).__name__)

    def invoke(self, args):
        self.fuel = 15000
        env = dict(zip([arg.arg for arg in self.function.args.args], args))
        self.bound(args)
        try:
            self.block(self.function.body, env)
        except Returned as result:
            return self.bound(result.value)
        except (Broke, Continued) as exc:
            raise CodeError("break/continue outside a loop") from exc
        except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError, OverflowError) as exc:
            raise CodeError(type(exc).__name__ + ": " + str(exc)) from exc
        return None

    def block(self, statements, env):
        for node in statements:
            self.tick()
            if isinstance(node, ast.Return):
                raise Returned(self.expr(node.value, env) if node.value is not None else None)
            if isinstance(node, ast.Assign):
                value = self.expr(node.value, env)
                for target in node.targets:
                    self.assign(target, value, env)
            elif isinstance(node, ast.AugAssign):
                value = self.binary(node.op, self.expr(node.target, env), self.expr(node.value, env))
                self.assign(node.target, value, env)
            elif isinstance(node, ast.For):
                values = self.expr(node.iter, env)
                if type(values) not in (list, tuple, dict, str):
                    raise CodeError("for needs a supported bounded iterable")
                values = list(values)
                self.bound(values)
                broke = False
                for value in values:
                    self.tick()
                    self.assign(node.target, value, env)
                    try:
                        self.block(node.body, env)
                    except Continued:
                        continue
                    except Broke:
                        broke = True
                        break
                if not broke:
                    self.block(node.orelse, env)
            elif isinstance(node, ast.If):
                self.block(node.body if self.expr(node.test, env) else node.orelse, env)
            elif isinstance(node, ast.Expr):
                self.expr(node.value, env)
            elif isinstance(node, ast.Pass):
                pass
            elif isinstance(node, ast.Break):
                raise Broke()
            elif isinstance(node, ast.Continue):
                raise Continued()
            elif not isinstance(node, ast.Return):
                raise UnsupportedSyntax("unsupported statement: " + type(node).__name__)

    def assign(self, target, value, env):
        self.bound(value)
        if isinstance(target, ast.Name):
            env[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            if type(value) not in (list, tuple) or len(target.elts) != len(value):
                raise CodeError("unpacking length/type mismatch")
            for child, item in zip(target.elts, value):
                self.assign(child, item, env)
        elif isinstance(target, ast.Subscript):
            container = self.expr(target.value, env)
            key = self.index(target.slice, env)
            if type(container) not in (list, dict) or isinstance(key, slice):
                raise UnsupportedSyntax("only list/dict item assignment is supported")
            container[key] = value
            self.bound(container)
        else:
            raise UnsupportedSyntax("unsupported assignment target")

    def index(self, node, env):
        if isinstance(node, ast.Slice):
            return slice(self.expr(node.lower, env) if node.lower else None,
                         self.expr(node.upper, env) if node.upper else None,
                         self.expr(node.step, env) if node.step else None)
        value = self.expr(node, env)
        if type(value) not in (int, str):
            raise CodeError("index must be an integer or string")
        return value

    def binary(self, op, left, right):
        self.tick()
        if isinstance(op, ast.Add) and type(left) is type(right) and type(left) in (list, tuple, str):
            if len(left) + len(right) > self.MAX_ITEMS:
                raise EvaluationLimit("concatenation too large")
            return self.bound(left + right)
        if type(left) not in (int, float, bool) or type(right) not in (int, float, bool):
            raise CodeError("arithmetic needs numbers")
        if isinstance(op, ast.Add): value = left + right
        elif isinstance(op, ast.Sub): value = left - right
        elif isinstance(op, ast.Mult): value = left * right
        elif isinstance(op, ast.Div): value = left / right
        elif isinstance(op, ast.FloorDiv): value = left // right
        elif isinstance(op, ast.Mod): value = left % right
        else: raise UnsupportedSyntax("unsupported arithmetic operator")
        return self.bound(value)

    def expr(self, node, env):
        self.tick()
        if isinstance(node, ast.Constant): return self.bound(node.value)
        if isinstance(node, ast.Name):
            if node.id not in env: raise CodeError("unknown variable: " + node.id)
            return env[node.id]
        if isinstance(node, ast.List): return self.bound([self.expr(x, env) for x in node.elts])
        if isinstance(node, ast.Tuple): return self.bound(tuple(self.expr(x, env) for x in node.elts))
        if isinstance(node, ast.Dict):
            if any(key is None for key in node.keys): raise UnsupportedSyntax("dict unpacking")
            return self.bound({self.expr(k, env): self.expr(v, env) for k, v in zip(node.keys, node.values)})
        if isinstance(node, ast.Subscript):
            container = self.expr(node.value, env)
            if type(container) not in (list, tuple, dict, str): raise CodeError("unsupported subscript value")
            return self.bound(container[self.index(node.slice, env)])
        if isinstance(node, ast.BinOp): return self.binary(node.op, self.expr(node.left, env), self.expr(node.right, env))
        if isinstance(node, ast.UnaryOp):
            value = self.expr(node.operand, env)
            if isinstance(node.op, ast.Not): return not value
            if type(value) not in (int, float, bool): raise CodeError("unary arithmetic needs number")
            return self.bound(-value if isinstance(node.op, ast.USub) else +value)
        if isinstance(node, ast.BoolOp):
            value = self.expr(node.values[0], env)
            for child in node.values[1:]:
                if isinstance(node.op, ast.And) and not value: return value
                if isinstance(node.op, ast.Or) and value: return value
                value = self.expr(child, env)
            return value
        if isinstance(node, ast.Compare):
            left = self.expr(node.left, env)
            for op, child in zip(node.ops, node.comparators):
                right = self.expr(child, env)
                if isinstance(op, ast.Eq): ok = left == right
                elif isinstance(op, ast.NotEq): ok = left != right
                elif isinstance(op, ast.Lt): ok = left < right
                elif isinstance(op, ast.LtE): ok = left <= right
                elif isinstance(op, ast.Gt): ok = left > right
                elif isinstance(op, ast.GtE): ok = left >= right
                elif isinstance(op, ast.In): ok = left in right
                elif isinstance(op, ast.NotIn): ok = left not in right
                elif isinstance(op, ast.Is): ok = left is right
                elif isinstance(op, ast.IsNot): ok = left is not right
                else: raise UnsupportedSyntax("unsupported comparison")
                if not ok: return False
                left = right
            return True
        if isinstance(node, ast.IfExp): return self.expr(node.body if self.expr(node.test, env) else node.orelse, env)
        if isinstance(node, (ast.ListComp, ast.GeneratorExp)):
            out = []
            self.comprehension(node.generators, 0, dict(env), node.elt, out)
            return self.bound(out)
        if isinstance(node, ast.Call): return self.call(node, env)
        raise UnsupportedSyntax("unsupported expression: " + type(node).__name__)

    def comprehension(self, generators, index, env, element, out):
        self.tick()
        if index == len(generators):
            if len(out) >= self.MAX_ITEMS: raise EvaluationLimit("comprehension too large")
            out.append(self.expr(element, env))
            return
        item = generators[index]
        values = self.expr(item.iter, env)
        if type(values) not in (list, tuple, dict, str): raise CodeError("unsupported comprehension iterable")
        for value in list(values):
            self.assign(item.target, value, env)
            if all(self.expr(condition, env) for condition in item.ifs):
                self.comprehension(generators, index + 1, env, element, out)

    def call(self, node, env):
        args = [self.expr(arg, env) for arg in node.args]
        kwargs = {kw.arg: self.expr(kw.value, env) for kw in node.keywords}
        if None in kwargs: raise UnsupportedSyntax("keyword unpacking")
        if isinstance(node.func, ast.Attribute):
            target = self.expr(node.func.value, env)
            if type(target) is not list or kwargs: raise UnsupportedSyntax("only list methods without keywords")
            if node.func.attr == "append" and len(args) == 1:
                if len(target) >= self.MAX_ITEMS: raise EvaluationLimit("list append limit")
                target.append(args[0])
                self.bound(target)
                return None
            if node.func.attr == "copy" and not args: return target.copy()
            raise CodeError("invalid list method arguments")
        name = node.func.id
        if name not in {"len", "range", "sum", "min", "max", "abs", "sorted"}:
            raise UnsupportedSyntax("unsupported function: " + name)
        if kwargs and not (name == "sorted" and set(kwargs) == {"reverse"} and type(kwargs["reverse"]) is bool):
            raise UnsupportedSyntax("unsupported builtin keyword arguments")
        if name == "range":
            if not 1 <= len(args) <= 3 or any(type(x) is not int for x in args): raise CodeError("invalid range arguments")
            result = range(*args)
            if len(result) > self.MAX_ITEMS: raise EvaluationLimit("range exceeds 1024 items")
            return list(result)
        if name == "len" and len(args) == 1 and type(args[0]) in (list, tuple, dict, str): return len(args[0])
        if name == "abs" and len(args) == 1 and type(args[0]) in (int, float): return self.bound(abs(args[0]))
        if name == "sorted" and len(args) == 1 and type(args[0]) in (list, tuple, dict, str): return self.bound(sorted(args[0], **kwargs))
        if name == "sum" and 1 <= len(args) <= 2 and type(args[0]) in (list, tuple):
            total = args[1] if len(args) == 2 else 0
            for value in args[0]: total = self.binary(ast.Add(), total, value)
            return self.bound(total)
        if name in {"min", "max"}:
            values = args[0] if len(args) == 1 and type(args[0]) in (list, tuple) else args
            if not values: raise CodeError("empty min/max")
            return self.bound(min(values) if name == "min" else max(values))
        raise CodeError("unsupported builtin argument count/type")


def grade_code(case, code):
    try:
        interpreter = Interpreter(code, case["function"], case["arguments"])
        for index, check in enumerate(case["checks"]):
            arguments = copy.deepcopy(check["args"])
            original = copy.deepcopy(arguments)
            value = interpreter.invoke(arguments)
            if arguments != original:
                return {"status": "fail", "reason": "input mutation", "check": index}
            if type(value) is not type(check["expected"]) or value != check["expected"]:
                return {"status": "fail", "reason": "incorrect result", "check": index,
                        "expected": check["expected"], "actual": value}
        return {"status": "pass", "checks_passed": len(case["checks"])}
    except UnsupportedSyntax as exc:
        return {"status": "unsupported_syntax", "reason": str(exc)}
    except EvaluationLimit as exc:
        return {"status": "evaluator_limit", "reason": str(exc)}
    except (CodeError, RecursionError) as exc:
        return {"status": "fail", "reason": str(exc)}
