"""Opt-in paired public-bug evaluation. No model calls unless --run is supplied.

Datasets/runs stay outside the repository; credentials are read only by the MCP client.
See docs/flash-next-bug-benchmark.md for limits and reproduction.
"""

import argparse
import ast
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = Path.home() / ".local/share/flash-next-evals"
PYTHON = BASE / "py310/bin/python"
PLUGIN = """import json, os
from pathlib import Path
records=[]
indices={}
def pytest_collection_modifyitems(items):
    indices.update({item.nodeid:i for i,item in enumerate(items)})
def pytest_runtest_logreport(report):
    if report.when == 'call' or report.failed or report.skipped:
        records.append(dict(node=report.nodeid,index=indices.get(report.nodeid,0),outcome=report.outcome,detail=str(report.longrepr) if report.failed else ''))
def pytest_sessionfinish(session,exitstatus):
    Path(os.environ['BENCH_REPORT']).write_text(json.dumps(dict(exitstatus=exitstatus,records=records)))
"""


def command(args, cwd=None, timeout=120):
    return subprocess.run(
        list(map(str, args)),
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=False,
    )


def digest(data):
    return hashlib.sha256(data.encode()).hexdigest()


def fetch(url):
    with urllib.request.urlopen(url, timeout=90) as r:
        return r.read()


def definitions(source, names):
    tree = ast.parse(source)
    lines = source.splitlines(keepends=True)
    selected = [
        n
        for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names
    ]
    assert len(selected) == len(names), (names, [n.name for n in selected])
    return "\n\n".join("".join(lines[n.lineno - 1 : n.end_lineno]) for n in selected)


def substitute(source, replacement, names):
    tree = ast.parse(replacement)
    if {
        n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))
    } != set(names):
        raise ValueError("Return exactly the editable definitions")
    if any(not isinstance(n, (ast.FunctionDef, ast.ClassDef)) for n in tree.body):
        raise ValueError("Only named definitions permitted")
    lines = source.splitlines(keepends=True)
    for n in sorted(
        [
            n
            for n in ast.parse(source).body
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names
        ],
        key=lambda n: n.lineno,
        reverse=True,
    ):
        lines[n.lineno - 1 : n.end_lineno] = [definitions(replacement, [n.name]) + "\n"]
    return "".join(lines)


def score(root, task):
    report = root / "bench-report.json"
    report.unlink(missing_ok=True)
    (root / "bench_plugin.py").write_text(PLUGIN)
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(root),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(root),
        "BENCH_REPORT": str(report),
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
    }
    # Tests may write only inside this disposable checkout and have no network.
    quoted = json.dumps(str(root))
    profile = f'(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath {quoted}) (literal "/dev/null"))'
    args = [
        "/usr/bin/sandbox-exec",
        "-p",
        profile,
        str(PYTHON),
        "-m",
        "pytest",
        "-p",
        "pytest_timeout",
        "-p",
        "bench_plugin",
        "--timeout=2",
        "--tb=short",
        "-q",
        "-o",
        "cache_dir=.pytest_cache",
        task["test"],
    ]
    try:
        p = subprocess.run(
            args,
            cwd=root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=65,
            check=False,
        )
        data = (
            json.loads(report.read_text())
            if report.exists()
            else {"exitstatus": p.returncode, "records": []}
        )
        data["log"] = p.stdout[-10000:]
    except subprocess.TimeoutExpired:
        data = {
            "exitstatus": 124,
            "records": [],
            "log": "Test subprocess exceeded 65 seconds",
        }
    # Anchor split membership to preflight, even if candidate import/collection changes.
    expected = task.get("expected_nodes")
    if expected is None and "preflight" in task:
        expected = [r["node"] for r in task["preflight"]["fixed"]["records"]]
    if expected is not None:
        if [r["node"] for r in data["records"]] != expected:
            data["exitstatus"] = -2
            data["log"] = "Candidate changed or prevented frozen test collection."
        indices = {node: i for i, node in enumerate(expected)}
        for record in data["records"]:
            record["index"] = indices.get(record["node"], 0)
    # Fixed collection-order parity defines feedback vs held-out, before model runs.
    for split, parity in [("feedback", 0), ("heldout", 1)]:
        cases = [
            r
            for r in data["records"]
            if r["index"] % 2 == parity and r["outcome"] != "skipped"
        ]
        data[split] = {
            "passed": sum(r["outcome"] == "passed" for r in cases),
            "total": len(cases),
            "ok": bool(cases)
            and all(r["outcome"] == "passed" for r in cases)
            and data["exitstatus"] in [0, 1],
        }
    data["ok"] = data["exitstatus"] == 0 and bool(data["records"])
    return data


def prepare(out):
    out.mkdir(parents=True, exist_ok=True)
    tasks = []
    q = BASE / "QuixBugs"
    b = BASE / "BugsInPy"
    for test in sorted((q / "python_testcases").glob("test_*.py")):
        name = test.stem[5:]
        editable = f"python_programs/{name}.py"
        t = {
            "id": "quix-" + name,
            "dataset": "QuixBugs",
            "source": str(q),
            "editable": editable,
            "test": str(test.relative_to(q)),
            "names": None,
            "contract": "Fix the defect while preserving the documented contract and public function signatures. Preserve return types and ordering.",
            "revision": command(["git", "rev-parse", "HEAD"], q).stdout.strip(),
        }
        tasks.append(t)
    # IDs chosen by category, before any candidate results.
    real = [
        (
            1,
            ["_match_one"],
            "Unary media-filter predicates must handle bool true/false as predicates, while preserving numeric comparisons and presence checks.",
        ),
        (
            3,
            ["unescapeHTML"],
            "Decode HTML entities correctly when literal ampersands are adjacent to named or numeric entities. Preserve unicode and malformed text.",
        ),
        (
            4,
            ["JSInterpreter"],
            "JavaScript interpreter must evaluate calls with zero arguments as well as existing argument-bearing calls.",
        ),
        (
            6,
            ["parse_dfxp_time_expr", "dfxp2srt"],
            "Convert TTML subtitles with explicit end times or duration. Skip entries lacking sufficient timing information; preserve valid zero timestamps.",
        ),
        (
            7,
            ["js_to_json"],
            "Convert JavaScript literals to valid JSON, including quoted strings with escaped apostrophes, preserving existing escape semantics.",
        ),
        (
            10,
            ["js_to_json"],
            "Convert JavaScript literals to valid JSON, preserving escaped unicode and newline characters in strings.",
        ),
    ]
    for bug, names, contract in real:
        info = (b / f"projects/youtube-dl/bugs/{bug}/bug.info").read_text()
        buggy = re.search(r'buggy_commit_id\s*=\s*"([a-f0-9]+)"', info)[1]
        fixed = re.search(r'fixed_commit_id\s*=\s*"([a-f0-9]+)"', info)[1]
        dest = BASE / f"youtube-dl-{bug}"
        if not dest.exists():
            raw = fetch(
                f"https://codeload.github.com/ytdl-org/youtube-dl/tar.gz/{fixed}"
            )
            with tempfile.NamedTemporaryFile(suffix=".tar.gz") as f:
                f.write(raw)
                f.flush()
                with tarfile.open(f.name) as tar:
                    members = tar.getmembers()
                    for m in members:
                        assert (
                            not m.issym()
                            and not m.islnk()
                            and ".." not in Path(m.name).parts
                            and not m.name.startswith("/")
                        )
                    temp = Path(tempfile.mkdtemp(dir=BASE))
                    tar.extractall(temp, filter="data")
                    shutil.move(str(next(temp.iterdir())), dest)
                    temp.rmdir()
        editable = "youtube_dl/jsinterp.py" if bug == 4 else "youtube_dl/utils.py"
        # Other support files and regression tests stay at the fixed commit; only
        # the bug-bearing file is replaced by its buggy commit version.
        bad = fetch(
            f"https://raw.githubusercontent.com/ytdl-org/youtube-dl/{buggy}/{editable}"
        ).decode()
        (dest / "benchmark-buggy-source.txt").write_text(bad)
        testcmd = (
            (b / f"projects/youtube-dl/bugs/{bug}/run_test.sh").read_text().strip()
        )
        target = testcmd.split()[-1].split(".")
        test = "/".join(target[:2]) + ".py"
        if bug == 4:
            test = "test/test_jsinterp.py"
        tasks.append(
            {
                "id": f"youtube-dl-{bug}",
                "dataset": "BugsInPy/youtube-dl",
                "source": str(dest),
                "editable": editable,
                "test": test,
                "names": names,
                "contract": contract,
                "revision": buggy,
                "fixed_revision": fixed,
            }
        )
    results = []
    for t in tasks:
        root = out / "preflight" / t["id"]
        shutil.copytree(
            t["source"],
            root,
            ignore=shutil.ignore_patterns(".git", "__pycache__"),
            dirs_exist_ok=True,
        )
        fixed = (
            (root / t["editable"]).read_text()
            if t["names"]
            else (
                root / ("correct_python_programs/" + Path(t["editable"]).name)
            ).read_text()
        )
        bad = (
            (root / "benchmark-buggy-source.txt").read_text()
            if t["names"]
            else (root / t["editable"]).read_text()
        )
        (root / t["editable"]).write_text(fixed)
        good = score(root, t)
        (root / t["editable"]).write_text(bad)
        broken = score(root, t)
        t["preflight"] = {"fixed": good, "buggy": broken}
        t["eligible"] = good["ok"] and not broken["ok"] and broken["exitstatus"] == 1
        t["original"] = bad
        t["code"] = definitions(bad, t["names"]) if t["names"] else bad
        t["context"] = ""
        if not t["names"] and "node" in bad.lower():
            t["context"] = (root / "python_programs/node.py").read_text()
        if t["names"]:
            # Include imports and directly referenced helper definitions, never fixed code.
            nodes = ast.parse(bad).body
            imports = "\n".join(
                ast.get_source_segment(bad, n)
                for n in nodes
                if isinstance(n, (ast.Import, ast.ImportFrom))
            )
            refs = {
                n.id for n in ast.walk(ast.parse(t["code"])) if isinstance(n, ast.Name)
            }
            helpers = [
                n.name
                for n in nodes
                if isinstance(n, (ast.FunctionDef, ast.ClassDef))
                and n.name in refs
                and n.name not in t["names"]
            ]
            t["context"] = imports + "\n\n" + definitions(bad, helpers)
        t["expected_nodes"] = [r["node"] for r in good["records"]]
        t["test_sha256"] = digest((root / t["test"].split("::")[0]).read_text())
        results.append(t)
        print(
            "PREFLIGHT",
            t["id"],
            t["eligible"],
            good["feedback"],
            good["heldout"],
            flush=True,
        )
    (out / "manifest.json").write_text(json.dumps(results, indent=2))
    return results


class MCP:
    def __init__(self, config):
        self.config = json.loads(Path(config).expanduser().read_text())["mcpServers"][
            "flash-next"
        ]

    def rpc(self, method, params):
        req = urllib.request.Request(
            self.config["url"],
            data=json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            ).encode(),
            headers={
                **self.config.get("headers", {}),
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=65) as r:
            body = json.load(r)
        if "error" in body:
            raise RuntimeError(body["error"])
        return body["result"]

    def tool(self, name, args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        if r.get("isError"):
            raise RuntimeError(r["content"][0]["text"])
        return json.loads(r["content"][0]["text"])

    def job(self, args, save):
        # Admission retries are not extra model attempts.
        for attempt in range(180):
            try:
                r = self.tool("submit_task", args)
                break
            except RuntimeError as e:
                if "already running" not in str(e):
                    raise
                time.sleep(2)
        else:
            raise RuntimeError("No worker slot after 6 minutes")
        tid = r["task_id"]
        print("MODEL", save.parent.name, save.stem, tid, flush=True)
        save.with_suffix(".request.json").write_text(json.dumps(args, indent=2))
        try:
            while r["state"] == "running":
                r = self.tool("wait_task", {"task_id": tid, "wait_seconds": 40})
            chunks = [r["output"]]
            offset = r.get("next_offset")
            while offset is not None:
                page = self.tool(
                    "wait_task", {"task_id": tid, "wait_seconds": 0, "offset": offset}
                )
                chunks.append(page["output"])
                offset = page.get("next_offset")
            r["output"] = "".join(chunks)
            save.write_text(json.dumps(r, indent=2))
            return r
        except BaseException:
            self.tool("cancel_task", {"task_id": tid})
            raise


def code_from(result):
    if result["state"] != "completed" or result.get("finish_reason") != "stop":
        raise ValueError("non-complete model output")
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", result["output"], re.DOTALL)
    code = blocks[0] if len(blocks) == 1 else result["output"]
    ast.parse(code)
    # No file/OS access is needed for these pure algorithm and parsing repairs.
    for n in ast.walk(ast.parse(code)):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = (
                [a.name for a in n.names]
                if isinstance(n, ast.Import)
                else [n.module or ""]
            )
            if any(
                m.split(".")[0]
                in {
                    "os",
                    "sys",
                    "subprocess",
                    "pathlib",
                    "importlib",
                    "pytest",
                    "correct_python_programs",
                    "builtins",
                }
                for m in mods
            ):
                raise ValueError("Forbidden import")
        if isinstance(n, ast.Name) and n.id in {
            "open",
            "exec",
            "eval",
            "compile",
            "__import__",
            "__builtins__",
        }:
            raise ValueError("Forbidden execution primitive")
    return code


def evaluate(task, result, root):
    try:
        code = code_from(result)
        full = (
            substitute(task["original"], code, task["names"]) if task["names"] else code
        )
        (root / task["editable"]).write_text(full)
        return score(root, task)
    except (SyntaxError, ValueError, TypeError, KeyError, OSError, AssertionError) as e:
        return {
            "ok": False,
            "exitstatus": -1,
            "feedback": {"ok": False, "total": 0, "passed": 0},
            "heldout": {"ok": False, "total": 0, "passed": 0},
            "records": [],
            "log": str(e),
        }


def feedback(ev):
    failures = [
        {"node": r["node"], "detail": r["detail"][:3500]}
        for r in ev["records"]
        if r["index"] % 2 == 0 and r["outcome"] not in ["passed", "skipped"]
    ]
    return (
        json.dumps(failures, ensure_ascii=False)[:10000]
        if failures
        else "Candidate failed parsing, validation or frozen test collection. Return valid Python preserving the required definitions and behavior. No held-out traceback is disclosed."
        if ev["exitstatus"] not in [0, 1]
        else "All feedback tests passed. No held-out results are disclosed."
    )


TASK = "Target Python 3.10. Repair the supplied buggy Python code to meet its contract. Preserve public signatures and behavior unrelated to the defect. Return only complete replacement editable code in one python code block, no prose. Do not access tests, files, network or reference solutions. Imports already in the enclosing module remain available. The independent test suite is not provided."


def trial(task, out, client):
    dest = out / "results" / task["id"]
    dest.mkdir(parents=True, exist_ok=True)
    if (dest / "summary.json").exists():
        return json.loads((dest / "summary.json").read_text())
    if any(dest.glob("*.json")):
        raise RuntimeError(
            "Partial task results exist; preserve the initial candidate and use a new run directory rather than silently regenerating it"
        )
    root = out / "work" / task["id"]
    shutil.copytree(
        task["source"],
        root,
        ignore=shutil.ignore_patterns(".git", "__pycache__"),
        dirs_exist_ok=True,
    )
    context = f"Contract: {task['contract']}\nEditable names: {task['names'] or 'whole module'}\nEditable buggy code:\n{task['code']}\nSupporting context (do not return/edit):\n{task['context']}"
    jobs = []
    roots = []
    try:
        a = client.job(
            {"task": TASK, "context": context, "reasoning": "on"}, dest / "a.json"
        )
        jobs.append(a)
        roots.append(a["task_id"])
        ae = evaluate(task, a, root)
        b = a
        be = ae
        stages = [a]
        reviews = []
        if a["state"] == "completed":
            for i in range(2):
                r = client.job(
                    {
                        "role": "review",
                        "parent_task_id": b["task_id"],
                        "task": "Review only concrete correctness defects against the original contract. Do not demand stylistic changes. Give a triggering input/expected behavior for each finding, or explicitly no findings. You have no test results. Keep the report concise.",
                        "reasoning": "on",
                    },
                    dest / f"b-review-{i}.json",
                )
                jobs.append(r)
                stages.append(r)
                reviews.append(r)
                # Keep passing candidates: independent tests, not rhetoric, gate repairs.
                if be["feedback"]["ok"] or r["state"] != "completed":
                    break
                b = client.job(
                    {
                        "role": "revise",
                        "parent_task_id": r["task_id"],
                        "task": "The coordinator confirms only these actual feedback-test failures. Fix them; review claims without evidence are advisory. Return complete editable code only.\n"
                        + feedback(be),
                        "reasoning": "on",
                    },
                    dest / f"b-revise-{i}.json",
                )
                jobs.append(b)
                stages.append(b)
                be = evaluate(task, b, root)
                if b["state"] != "completed":
                    break
        # Test-only control gets identical failure information, no reviewer report.
        c = a
        ce = ae
        cstages = [a]
        for i in range(2 if a["state"] == "completed" else 0):
            if ce["feedback"]["ok"]:
                break
            c = client.job(
                {
                    "task": TASK
                    + "\nFix the coordinator-confirmed feedback-test failures below.",
                    "context": context
                    + "\nCurrent candidate:\n"
                    + c["output"]
                    + "\nFeedback:\n"
                    + feedback(ce),
                    "reasoning": "on",
                },
                dest / f"c-repair-{i}.json",
            )
            jobs.append(c)
            roots.append(c["task_id"])
            cstages.append(c)
            ce = evaluate(task, c, root)
            if c["state"] != "completed":
                break

        def arm(ev, stages):
            return {
                "test": ev,
                "model_calls": len(stages),
                "seconds": round(sum(s.get("elapsed_ms", 0) for s in stages) / 1000, 3),
                "prompt_tokens": sum(
                    s.get("usage", {}).get("prompt_tokens", 0) for s in stages
                ),
                "completion_tokens": sum(
                    s.get("usage", {}).get("completion_tokens", 0) for s in stages
                ),
                "states": [s["state"] for s in stages],
            }

        summary = {
            "id": task["id"],
            "dataset": task["dataset"],
            "A": arm(ae, [a]),
            "B": arm(be, stages),
            "C": arm(ce, cstages),
            "review_reports": [r["output"] for r in reviews],
        }
        (dest / "summary.json").write_text(json.dumps(summary, indent=2))
        print(
            "RESULT",
            task["id"],
            {k: summary[k]["test"]["heldout"]["ok"] for k in "ABC"},
            flush=True,
        )
        return summary
    finally:
        for tid in roots:
            try:
                client.tool("release_task", {"task_id": tid})
            except (OSError, RuntimeError, ValueError) as e:
                print("CLEANUP", str(e), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--prepare", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    ap.add_argument("--config", default="~/.pi/agent/mcp.json")
    args = ap.parse_args()
    if args.prepare:
        prepare(args.output)
    if args.run:
        client = MCP(args.config)
        tasks = json.loads((args.output / "manifest.json").read_text())
        tasks = [t for t in tasks if t["eligible"]]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(trial, t, args.output, client) for t in tasks]
            results = []
            for task, future in zip(tasks, futures):
                try:
                    results.append(future.result())
                except Exception as exc:  # noqa: BLE001 - record infrastructure errors, never score as passes
                    results.append(
                        {
                            "id": task["id"],
                            "runner_error": f"{type(exc).__name__}: {exc}",
                        }
                    )
        (args.output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
