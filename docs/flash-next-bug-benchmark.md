# Flash Next public-bug comparison

This is a local, descriptive paired experiment of the deployed lightweight review workflow. It is not a reproduction of GVS5H's harness or published scores, and is not a full autonomous repository-agent benchmark.

## Reproduce

Source datasets:

- [QuixBugs](https://github.com/jkoppel/QuixBugs), revision `4257f44b0ff1181dedaedee6a447e133219fcebf`: all 40 Python test modules, no selection based on candidate results.
- [BugsInPy](https://github.com/soarsmu/BugsInPy), youtube-dl IDs 1, 3, 4, 6, 7 and 10: filtering, HTML decoding, JavaScript interpretation, subtitle timing and string escaping. Exact buggy/fixed revisions come from `bug.info` and are saved in the run manifest. These six categories were selected before model runs.

Clone these repositories to `~/.local/share/flash-next-evals/QuixBugs` and `BugsInPy`. Create a Python 3.10 virtual environment at `~/.local/share/flash-next-evals/py310` and install `pytest` and `pytest-timeout`. The script requires macOS `sandbox-exec`. It copies each task to a disposable directory, denies test network access and writes outside the task directory, and limits each test to 2 seconds / each test process to 65 seconds. Do not run unknown model code without this isolation.

```sh
python3 tests/flash-next-bug-benchmark.py --prepare --output /absolute/path/to/run
python3 tests/flash-next-bug-benchmark.py --run --output /absolute/path/to/run --workers 2
```

The private MCP configuration is read from `~/.pi/agent/mcp.json`, or `--config`. Credentials and full runtime transcripts stay outside the repository. A prepared manifest contains original source, contracts, test hashes, source revisions and preflight outcomes. Each eligible task must fail with the buggy file and pass with the official fixed file. The fixed file is used only for environment preflight, never sent to a worker. For youtube-dl, support files and regression tests are at the fixed revision, with only the bug-bearing file overlaid from the buggy revision; this is a localized repair test, not a clean checkout of the entire buggy revision.

## Paired arms

- **A: one-shot.** Generate one candidate, then run frozen tests.
- **B: reviewed.** Start from exactly A's candidate. Use the actual MCP `review` role in a fresh context. Only reproducible feedback-test failures authorize a `revise` call, at most twice. Review reports are advisory. If feedback tests already pass, stop after review and retain the candidate, even if review prose suggests speculative changes.
- **C: tests only.** Start from exactly A's candidate. Allow up to two revisions from the same feedback failure format, without an independent review. C uses fresh single-task calls; B uses deployed role-specific prompts, so their prompts are not byte-identical.

All calls use fixed `pennyroyal`, reasoning on and the MCP default 32768 output-token limit. No paid model supplies solutions, test expected values or revisions. The coordinator mechanically executes tests. The backend's sampling defaults are unchanged; no seed override is exposed by this MCP. This first trial has one generation per task, not repeated independent trials.

Tests are split by their original collection order: even indexes provide feedback, odd indexes are held out. Full-suite pass is reported alongside held-out pass, and tasks whose original bug is not exposed in held-out cases must be identified separately. Missing/changed collection must be audited, not counted as a pass. Upstream skipped tests remain skipped. Model-generated tests cannot replace the frozen suite.

## Interpretation

Count actual rescues (A fails, B passes) and regressions (A passes, B fails), not reviewer finding counts. Compare B against C to separate added review from simply receiving test feedback and spending more model calls. Record prompt/completion tokens and the sum of per-call model elapsed times; summed model time is not end-to-end wall time when tasks run concurrently. Shared initial-generation cost is included in each arm when estimating what that arm would cost independently.

This is a conservative test-confirmed workflow: it measures review-assisted repair and review overhead, not the maximum ability of a human coordinator to confirm new reviewer-only counterexamples. Reviewers can be wrong; no speculative reviewer edits are accepted merely to force a visible difference. Passing a partial test suite does not prove correctness. Public benchmark familiarity, small localized defects, a single trial, unequal total compute and possible shared-server load limit generalization to daily coding work.

The 2026-09-26 results are recorded in the companion result report. No service configuration or production project is changed by this evaluation.
