"""Exercise the actual patched backend with the deployed tokenizer, without GPU."""
import json
import os
import sys
from pathlib import Path

from transformers import AutoTokenizer
from sglang.srt.constrained.xgrammar_backend import XGrammarGrammarBackend


def main():
    path = Path(sys.argv[1])
    tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
    config = json.loads((path / "config.json").read_text())["text_config"]
    eos = json.loads((path / "generation_config.json").read_text())["eos_token_id"]
    backend = XGrammarGrammarBackend(tokenizer, config["vocab_size"], eos, any_whitespace=True)

    def accepts(schema, text):
        grammar = backend.dispatch_json(json.dumps(schema))
        for token in tokenizer.encode(text, add_special_tokens=False):
            if not grammar.matcher.accept_token(token):
                return False
        return grammar.matcher.accept_token(eos[0])

    cases = [
        ({"type": "string"}, '\n\n"NEG_ZERO"', True),
        ({"type": "string"}, ' \t\r\n"ok"', True),
        ({"type": "string"}, '"ok"', True),
        ({"type": "string"}, ' "ok"', True),
        ({"type": "string"}, '        "ok"', True),
        ({"type": "string"}, '         "ok"', False),
        ({"type": "string"}, '\v"ok"', False),
        ({"type": "string"}, '\u00a0"ok"', False),
        ({"type": "string"}, 'oops"ok"', False),
        ({"type": "string"}, '\n\n', False),
        ({"type": "string"}, '\n{"r":"ok"}', False),
        ({"type": "string"}, '"bad\nstring"', False),
        ({"type": "string"}, '"x" "y"', False),
        ({"type": "string"}, '"x"\n', False),
        ({"type": "string", "pattern": "^[A-Z]{2}$"}, '\n"AB"', True),
        ({"type": "string", "pattern": "^[A-Z]{2}$"}, '\n"ab"', False),
        ({"type": "integer"}, '\n58', True),
        ({"type": "integer"}, '\n"58"', False),
        ({"enum": ["OK", "NO"]}, '\n"OK"', True),
        ({"enum": ["OK", "NO"]}, '\n"MAYBE"', False),
        ({"type": "boolean"}, '\ntrue', True),
        ({"type": "null"}, '\nnull', True),
        ({"type": "array", "items": {"type": "integer"}}, '\n[1,2]', True),
        ({"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}, '\n{"n":2}', True),
        ({"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}, '\n{"n":"bad"}', False),
        ({"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False}, '\n{"n":2,"extra":1}', False),
    ]
    recursive = {"$defs": {"node": {"type": "object", "properties": {"next": {"anyOf": [{"$ref": "#/$defs/node"}, {"type": "null"}]}}, "required": ["next"], "additionalProperties": False}}, "$ref": "#/$defs/node"}
    cases += [(recursive, '\n{"next":{"next":null}}', True), (recursive, '\n{"next":"bad"}', False)]
    for schema, text, expected in cases:
        assert accepts(schema, text) == expected, (schema, text, expected)
    backend.any_whitespace = False
    assert accepts({"type": "string"}, '"ok"')
    assert not accepts({"type": "string"}, '\n"ok"')
    backend.any_whitespace = True
    os.environ["SGLANG_JSON_ROOT_WHITESPACE"] = "0"
    assert accepts({"type": "string"}, '"ok"')
    assert not accepts({"type": "string"}, '\n"ok"')
    print(f"PASS {len(cases) + 4} native grammar cases; schema restrictions preserved")


if __name__ == "__main__":
    main()
