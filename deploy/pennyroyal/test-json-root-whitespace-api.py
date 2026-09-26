"""Live regression for reasoning + JSON output; saves full evidence outside Git."""
import argparse
import json
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prompt = "JS执行：let x=-0; let r=x>0?'POS':x===0&&Object.is(x,-0)?'NEG_ZERO':x===0&&Object.is(x,0)?'POS_ZERO':'OTHER'; 仅输出r对应的JSON字符串。必须只返回带双引号的JSON字符串字面量，不要对象或解释。"
    cases = [(f"string-thinking-{i}", prompt, {"type": "string"}, "NEG_ZERO", True) for i in range(10)]
    cases += [(f"string-no-thinking-{i}", prompt, {"type": "string"}, "NEG_ZERO", False) for i in range(3)]
    cases += [(f"integer-{i}", "只输出JSON整数：17*23的余数mod7，加上100后二进制的1个数乘13，再加原余数。", {"type": "integer"}, 58, True) for i in range(3)]
    cases += [
        ("object", "Return JSON with n as the integer 2. No other fields.", {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}, {"n": 2}, True),
        ("enum", "Return the JSON string OK.", {"enum": ["OK", "NO"]}, "OK", True),
        ("array", "Return JSON array of integers 1,2,3.", {"type": "array", "items": {"type": "integer"}}, [1, 2, 3], True),
        ("json-object", "Return a JSON object with the sole key n and integer value 2.", None, {"n": 2}, True),
    ]
    report = {"runs": []}
    for name, prompt, schema, expected, thinking in cases:
        body = {"model": "pennyroyal", "messages": [{"role": "user", "content": prompt}], "temperature": 0, "seed": 42, "max_tokens": 4096, "logprobs": True, "top_logprobs": 5, "chat_template_kwargs": {"enable_thinking": thinking, "reasoning_effort": "medium"}}
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "regression", "strict": True, "schema": schema}} if schema is not None else {"type": "json_object"}
        with urllib.request.urlopen(args.url.removesuffix("/v1").rstrip("/") + "/flush_cache", timeout=30) as r:
            assert r.status == 200
        req = urllib.request.Request(args.url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            result = json.load(r)
        choice = result["choices"][0]
        text = choice["message"]["content"]
        try:
            passed = json.loads(text) == expected and choice["finish_reason"] == "stop"
        except (ValueError, TypeError):
            passed = False
        report["runs"].append({"name": name, "passed": passed, "request": body, "response": result})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"name": name, "passed": passed, "content": text}, ensure_ascii=False), flush=True)
    report["passed"] = sum(r["passed"] for r in report["runs"])
    report["total"] = len(report["runs"])
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    assert report["passed"] == report["total"], f"{report['passed']}/{report['total']} passed"


if __name__ == "__main__":
    main()
