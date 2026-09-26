# Flash Next short execution-rule screening — 2026-09-26

## Decision

Do not install the tested rule block in Pi. It helped one literal-output task, but introduced a regex replacement error and did not improve the strict aggregate success count. A relaxed scoring interpretation gives one additional successful sample, which is insufficient evidence of a reliable improvement. No production prompts, model weights, sampling defaults, service configuration, or MCP registrations were changed by this experiment.

This screens a small, locally written rule block inspired by agent execution guidance. It does **not** validate, reproduce, or install the third-party [CL4R1T4S material](https://github.com/elder-plinius/CL4R1T4S/blob/f0052f05837c6dcfec5ed70179bb761f2593146a/ANTHROPIC/CLAUDE-OPUS-5.5.md). In particular, it does not measure the effect of the complete vendor prompt or a full Pi session with tool calls and long history.

## Frozen design

- Same live `pennyroyal` model, confirmed mounted from `Swift-1.5-Qwen3.8-Flash-Next-NVFP4-PLE-FP8`; SGLang `0.5.19+g2d6689abdac6`, MTP active (server reports `EAGLE`), context 524288, request capacity 4, KV `fp8_e4m3`.
- Baseline: a short instruction to complete coding tasks and follow their requested output format. This is **not** Pi's existing complete system prompt.
- Treatment: the same instruction plus five rules: obey interpreter version; reduce nested escaping; pass data through arguments/stdin; prefer quoted heredocs for embedded code; silently check punctuation/names/boundaries and never claim unperformed tests.
- 16 fixed tasks: six Python quoting/compatibility tasks, six Bash tasks, four ordinary pure-function controls. Hidden input/output fixtures were frozen before the first measured response.
- Two requested seeds (4200, 4201), temperature 1, medium reasoning, 8192 output-token limit, same task text in both arms. Seeds are not a guarantee of deterministic serving.
- 64 serial requests, alternating AB/BA order across tasks and repeats, no feedback, no repair attempts, no extra review agents in the measured workflow. The shared production cache was not flushed.
- Raw source is evaluated exactly as returned, with no arm-specific extraction or repair. All runs completed with `finish_reason=stop`; none were truncated.
- Local Docker execution: Python 3.9 and Bash 5.2.15, no network, read-only root filesystem, non-root user, no host mounts, limited CPU/memory/processes, ephemeral tmpfs. Each task's known-correct reference passed, and a deliberately wrong-output candidate failed before measurement.
- Frozen manifest SHA256: `dcbec7a347903e095e52b84a9652e2be779fa11b8fb88d6115932fc7cff124bc`. Exact prompt strings, fixtures and image ID are retained in the local raw report. Source: `deploy/pennyroyal/benchmark-prompt-rules.py`.

Flash Next supplied preliminary case ideas; inconsistent examples were discarded and all adopted oracles were independently fixed and checked. Claude reviewed the experimental design, recommending ordinary controls and explicit caveats about sampling, length and timing. Neither model judged the measured answers: executable fixtures did.

## Results

| Measure | Baseline | Added rules |
| --- | ---: | ---: |
| Strict first-attempt successes | 29/32 (90.625%) | 29/32 (90.625%) |
| Syntax checks passed | 32/32 | 32/32 |
| Ordinary functional controls | 8/8 | 8/8 |
| Relaxed empty-argument exit-code interpretation | 30/32 (93.75%) | 31/32 (96.875%) |
| Median API request elapsed time | 2.661 s | 3.088 s |
| Sum of API request elapsed times | 124.027 s | 155.592 s |
| Completion tokens, including reasoning | 15,853 | 16,253 |
| Prompt tokens reported across all requests | 3,318 | 7,030 |

Strict paired samples: treatment wins 2, loses 2, ties 28. At the task level (combining the two repeats), treatment wins 1, loses 2, ties 13; the exploratory two-sided sign-test p-value is 1. This does not prove equivalence. Sixteen selected tasks and two repeats are a small screening sample.

### Actual failures

1. **Literal heredoc content, baseline 0/2 vs treatment 2/2:** the baseline dropped one of two required literal backslashes in embedded Python source. Both outputs were valid Bash, but produced different text from the requested text. This is a real, repeated local benefit.
2. **Python backslash replacement, baseline 2/2 vs treatment 1/2:** one treatment answer used `re.sub` with a replacement string that was an incomplete regex escape. Python parsed the function, but calling it raised an error. The baseline used a working implementation. Syntax checking alone would not catch this.
3. **Empty Bash argument list, baseline 1/2 vs treatment 0/2 under the strict oracle:** three answers used a conditional followed by `&& printf`. They printed the right empty output but exited 1 when there were no arguments. The prompt explicitly required empty output but did **not** explicitly require exit 0; successful exit was an extra oracle assumption. Treating these answers as acceptable raises the totals to 30/32 vs 31/32. Both interpretations are reported rather than hiding the ambiguity or rewriting the task after observing responses.

## Limits and follow-up policy

The experiment provides no reliable general speedup or quality uplift. API timings include shared-service queueing, cache state and possible other traffic; the observed treatment slowdown is descriptive, not a controlled throughput claim. There was no equal-length neutral reminder arm, so any benefit cannot be attributed solely to the particular rule wording. Bash ran under the specified 5.2 version, not macOS's default 3.2. These short code tasks do not reproduce a long Pi session's complete tool/serialization environment.

The predeclared adoption gate required replicated gains on at least two tasks without regressions, followed by fresh holdout verification. That gate was not met, so no holdout expansion or production installation was performed. The useful lesson is narrow: a short instruction can help preserve literal code, but it cannot replace functional checks and can also coincide with new errors.

Raw responses and execution evidence remain outside Git at `~/.local/share/model-deployments/prompt-rules-20260926/paired.json`. No credentials, production session histories, model artifacts or raw model reasoning are committed.
