"""Deterministic, oracle-scored smoke comparison via an OpenAI-compatible API.

No model-generated code is executed. Results and prompts are local artifacts.
"""
import argparse
import ast
import re
import subprocess
import base64
import json
import statistics
import struct
import time
import urllib.request
import urllib.error
import zlib
from pathlib import Path


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def cases():
    red = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
    red += png_chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\0\0" * 32) * 32)) + png_chunk(b"IEND", b"")
    items = [
        ("python_fix", "Python意图是求1至4的平方和，再加hello[1:4]的长度。现有表达式sum(i*2 for i in range(1,5))+len('hello'[1:4])有错。只返回JSON对象，字段expression为修复后的表达式字符串，value为结果整数。", {"expression": "sum(i*i for i in range(1,5))+len('hello'[1:4])", "value": 33}),
        ("js_boundary", "JS执行：let x=-0; let r=x>0?'POS':x===0&&Object.is(x,-0)?'NEG_ZERO':x===0&&Object.is(x,0)?'POS_ZERO':'OTHER'; 仅输出r对应的JSON字符串。", "NEG_ZERO"),
        ("log_extract", "仅输出按时间升序的JSON数组，包含所有FAULT时间(HH:MM:SS)，不包括WARN。\n[2026-09-26 14:55:19] FAULT process\n[2026-09-26 08:22:11] INFO start\n[2026-09-26 10:03:28] FAULT network\n[2026-09-26 09:05:33] WARN latency\n[2026-09-26 09:17:02] FAULT disk", ["09:17:02", "10:03:28", "14:55:19"]),
        ("json_rules", "只输出JSON对象：name=张三；age=name的汉字数乘12；tags严格等于[Z,active]字符串数组；score=age除以4向下取整。", {"name": "张三", "age": 24, "tags": ["Z", "active"], "score": 6}),
        ("stable_sort", "按priority降序，再按created升序，相同保持输入顺序。只输出id的JSON数组。输入：[{id:'a',priority:2,created:8},{id:'b',priority:3,created:9},{id:'c',priority:2,created:5},{id:'d',priority:3,created:9},{id:'e',priority:2,created:5}]", ["b", "d", "c", "e", "a"]),
        ("integer_steps", "仅输出JSON整数：a=17*23；b=a%7；c=b+100；d是c的二进制中1的数量；结果d*13+b。", 58),
        ("retry_boundary", "一个任务最多尝试4次，开始时t=0。每次请求耗时3秒，失败后等待2**(attempt-1)秒，attempt从1开始。若完成本次等待后t>=12，立即退出，不再请求；成功立即退出。第1、2、3次失败，第4次本会成功。只输出JSON {attempts:实际请求次数,elapsed:退出时秒数,success:是否成功}。", {"attempts": 3, "elapsed": 16, "success": False}),
        ("interval_merge", "区间为左闭右开，只有实际重叠才合并，首尾相接不合并。将[[1,4],[4,7],[2,3],[6,9],[12,15],[10,12],[14,18]]合并并升序，仅输出JSON数组。", [[1, 4], [4, 9], [10, 12], [12, 18]]),
    ]
    result = [{"id": i, "prompt": p, "expected": e} for i, p, e in items]
    # A fixed ~20K-character context with revision selection and distracting records.
    records = [{"id": f"svc-{i:04d}", "rev": 1, "port": 10000 + i, "enabled": True} for i in range(320)]
    records.insert(30, {"id": "svc-0173", "rev": 3, "port": 23173, "enabled": False})
    records.insert(270, {"id": "svc-0173", "rev": 2, "port": 21173, "enabled": True})
    result.append({"id": "long_lookup", "prompt": "从记录中找出svc-0173，按rev最高的记录为准而不是出现顺序。仅输出其port和enabled两字段JSON。\n" + json.dumps(records), "expected": {"port": 23173, "enabled": False}})
    result.append({"id": "vision", "prompt": "Return JSON with color as the dominant color in English lowercase, and product as 6*7.", "image": "data:image/png;base64," + base64.b64encode(red).decode(), "expected": {"color": "red", "product": 42}})
    result.append({"id": "tool", "prompt": "Call lookup_weather for Shanghai, unit celsius. Use the tool now.", "tool": True, "expected": {"city": "Shanghai", "unit": "celsius"}})
    result.append({"id": "throughput", "prompt": "Output only a JSON array of every integer from 1 through 256 inclusive, in ascending order. No ellipses, no prose.", "expected": list(range(1, 257))})
    result.append({"id": "fixed_decode", "prompt": "Write a detailed Python module implementing an LRU cache with examples and tests. Keep writing until finished.", "speed_only": True})
    return result


def code_cases():
    return [
        {"id": "python_escape", "prompt": "只输出Python代码。实现函数parse_assignment(line)，用标准库shlex解析一行key=\"value with spaces\"。支持值内转义双引号，返回(key,value)元组；缺少等号抛ValueError。不要执行示例。", "syntax": "python", "required_name": "parse_assignment"},
        {"id": "python_cache", "prompt": "只输出Python代码，实现class TTLCache，方法__init__(self,ttl)、get(self,key)、set(self,key,value)。用time.monotonic维护每项过期时间；get过期返回None并删除。set不得修改其他项的时间。带类型注解。不要执行示例。", "syntax": "python", "required_name": "TTLCache"},
        {"id": "js_escape", "prompt": "Output JavaScript code only. Implement function escapeHtml(text), escaping &, <, >, double quote and apostrophe exactly once using a single replace with a mapping object. Include no execution examples.", "syntax": "javascript", "required_name": "escapeHtml"},
        {"id": "js_debounce", "prompt": "Output JavaScript code only. Implement function debounceAsync(fn, delayMs). Calls made before timer fires share the result of the last arguments. Return a Promise per call; propagate errors to all waiting callers and preserve this. No imports or execution examples.", "syntax": "javascript", "required_name": "debounceAsync"},
    ]


def diagnostic_cases():
    selected = {c["id"]: c for c in cases()}
    js = selected["js_boundary"]
    js["prompt"] += "必须只返回带双引号的JSON字符串字面量，不要对象或解释。"
    js["response_schema"] = {"type": "string"}
    vision = selected["vision"]
    vision["prompt"] = "Return a JSON object: color is the dominant image color in lowercase English; product is the integer result of multiplying 6 by 7."
    vision["response_schema"] = {"type": "object", "properties": {"color": {"type": "string"}, "product": {"type": "integer"}}, "required": ["color", "product"], "additionalProperties": False}
    interval = selected["interval_merge"]
    interval["effort"] = "high"
    return [js, vision, interval]


def parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def score(case, text, calls):
    try:
        if case.get("syntax"):
            code = text.strip()
            if code.startswith("```"):
                code = code.split("\n", 1)[1].rsplit("```", 1)[0]
            if case["syntax"] == "python":
                tree = ast.parse(code)
                return any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == case["required_name"] for node in tree.body)
            if not re.search(r"\bfunction\s+" + re.escape(case["required_name"]) + r"\s*\(", code):
                return False
            return subprocess.run(["node", "--input-type=module", "--check"], input=code, text=True, capture_output=True, timeout=10).returncode == 0
        if case.get("tool"):
            call = calls[0]
            return call["name"] == "lookup_weather" and json.loads(call["arguments"]) == case["expected"]
        value = parse_json(text)
        if case["id"] == "python_fix":
            # Check the result and accept common equivalent square expressions.
            expr = value["expression"].replace(" ", "").replace('"', "'")
            valid = [f"sum({square}foriinrange(1,5))+len('hello'[1:4])" for square in ("i*i", "i**2", "pow(i,2)")]
            return value["value"] == 33 and expr in valid
        return value == case["expected"]
    except (ValueError, KeyError, IndexError, TypeError, SyntaxError, subprocess.TimeoutExpired):
        return False


def run_case(url, case):
    content = case["prompt"]
    if case.get("image"):
        content = [{"type": "text", "text": content}, {"type": "image_url", "image_url": {"url": case["image"]}}]
    body = {"model": "pennyroyal", "messages": [{"role": "user", "content": content}], "temperature": case.get("temperature", 0), "seed": 42, "max_tokens": 4096, "stream": True, "stream_options": {"include_usage": True}, "chat_template_kwargs": {"enable_thinking": True, "reasoning_effort": "medium"}}
    if case.get("tool"):
        body["tools"] = [{"type": "function", "function": {"name": "lookup_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["city", "unit"]}}}]
        body["tool_choice"] = {"type": "function", "function": {"name": "lookup_weather"}}
    if case.get("response_schema"):
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "diagnostic", "strict": True, "schema": case["response_schema"]}}
    if case.get("effort"):
        body["chat_template_kwargs"]["reasoning_effort"] = case["effort"]
    if case.get("speed_only"):
        body["max_tokens"] = 512
        body["ignore_eos"] = True
    # Make each measured prompt cold; do not include this maintenance time.
    deadline = time.monotonic() + 120
    while True:
        try:
            with urllib.request.urlopen(url.removesuffix("/v1").rstrip("/") + "/flush_cache", timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError("Cache flush failed")
            break
        except urllib.error.HTTPError as error:
            if error.code != 400 or time.monotonic() >= deadline:
                raise
            time.sleep(1)
    request = urllib.request.Request(url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    start = time.monotonic()
    first = first_content = last = None
    text, reasoning, calls, usage, finish = "", "", {}, {}, None
    events = []
    with urllib.request.urlopen(request, timeout=300) as response:
        for raw in response:
            if not raw.startswith(b"data: "):
                continue
            data = raw[6:].strip()
            if data == b"[DONE]":
                break
            event = json.loads(data)
            events.append({"received_s": time.monotonic() - start, "event": event})
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices", []):
                delta = choice.get("delta", {})
                if delta.get("content") or delta.get("reasoning_content") or delta.get("tool_calls"):
                    now = time.monotonic()
                    first = first or now
                    last = now
                if delta.get("content") or delta.get("tool_calls"):
                    first_content = first_content or time.monotonic()
                text += delta.get("content") or ""
                reasoning += delta.get("reasoning_content") or ""
                for call in delta.get("tool_calls", []):
                    target = calls.setdefault(call["index"], {"name": "", "arguments": ""})
                    for key in target:
                        target[key] += call.get("function", {}).get(key) or ""
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
    elapsed = time.monotonic() - start
    tokens = usage.get("completion_tokens", 0)
    return {"id": case["id"], "passed": (tokens == 512 and finish == "length") if case.get("speed_only") else score(case, text, calls), "finish_reason": finish, "elapsed_s": elapsed, "ttft_s": first - start if first else None, "first_answer_s": first_content - start if first_content else None, "decode_tokens_s": tokens / (last - first) if tokens and first and last > first else None, "output_tokens_s": tokens / elapsed, "usage": usage, "output": text, "reasoning": reasoning, "tool_calls": calls, "stream_events": events}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--code-only", action="store_true")
    parser.add_argument("--temperature", type=float, default=0)
    args = parser.parse_args()
    if not 0 <= args.temperature <= 2 or args.repeats < 1:
        parser.error("temperature must be 0..2 and repeats must be positive")
    if args.code_only and args.diagnostics:
        parser.error("--code-only and --diagnostics select different suites")
    suite = code_cases() if args.code_only else diagnostic_cases() if args.diagnostics else cases() + (code_cases() if args.extended else [])
    for case in suite:
        case["temperature"] = args.temperature
    report = {"label": args.label, "temperature": args.temperature, "repeats": args.repeats, "cases": suite, "warmups": [], "runs": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for case in suite:
        report["warmups"].append(run_case(args.url, case))
        for repeat in range(args.repeats):
            result = run_case(args.url, case)
            result["repeat"] = repeat
            report["runs"].append(result)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({key: result[key] for key in ("id", "repeat", "passed", "elapsed_s", "decode_tokens_s", "finish_reason")}), flush=True)
    report["summary"] = {"passed": sum(r["passed"] for r in report["runs"]), "total": len(report["runs"]), "cases": {c["id"]: {"passed": sum(r["passed"] for r in report["runs"] if r["id"] == c["id"]), "median_elapsed_s": statistics.median(r["elapsed_s"] for r in report["runs"] if r["id"] == c["id"]), "median_decode_tokens_s": statistics.median(r["decode_tokens_s"] for r in report["runs"] if r["id"] == c["id"] and r["decode_tokens_s"])} for c in suite}}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report["summary"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
