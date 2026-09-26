# Local model MCP worker

`bin/local-model-mcp.mjs` is a standalone Node 22+ stdio MCP server. Codex owns orchestration and review; a fixed OpenAI-compatible model supplies analysis, code, patches and image interpretation. No Pi/web service restart or Python/npm dependencies are needed.

Configure `LOCAL_MODEL_BASE_URL` (including `/v1`), `LOCAL_MODEL_ID`, and optionally `LOCAL_MODEL_API_KEY` in the local environment. Never commit endpoint credentials. The tool cannot select another model or silently fall back.

Example registration (replace the placeholders with your endpoint/model):

```sh
codex mcp add flash-next --env LOCAL_MODEL_BASE_URL=http://YOUR_HOST:8000/v1 --env LOCAL_MODEL_ID=YOUR_MODEL -- /absolute/path/to/node /absolute/path/to/local-model-mcp.mjs
```

Tools:

- `model_status`: check the configured model is listed by the endpoint.
- `submit_task`: supply `task`, optional source text in `context`, optional `image_paths` (up to four absolute PNG/JPEG/WebP files, each at most 10 MiB), and optional per-call `max_tokens` (64–65536, default 32768). Immediately returns a task ID. Only explicitly attached files are read and uploaded. The model has no independent filesystem or execution tools. Optional `role` selects `generate` (default), `review`, or `revise`; the latter two require `parent_task_id` and inherit original context/images.
- `wait_task`: supply `task_id`, optional `wait_seconds` (0–50) and `offset`. Repeat until completed/incomplete/failed/cancelled. Output is returned in 24000-character pages; follow `next_offset`. `finish_reason: length` means the response is truncated and may need a follow-up task.
- `cancel_task`: abort the HTTP request; backend cancellation latency depends on the inference server.
- `release_task`: after collecting the results and finishing the workflow, pass any related `task_id` to delete all its retained records. Refuses if a related task is running. This does not undo any applied code.

Each MCP process allows four running jobs, with a 15-minute deadline per job. Completed jobs do not occupy running slots. Output is retained in memory for up to an hour after each job terminates (pruned on new submissions). At 256 retained records (configurable with `LOCAL_MCP_MAX_RECORDS`), new submissions are rejected with instructions to collect results and `release_task` a finished workflow; unexpired results are never silently evicted. Restarting/disconnecting the MCP process cancels jobs and loses results. There is no automatic wakeup of a finished Codex turn: the coordinator must explicitly wait and collect required results before ending. This adapter does not automatically edit files or execute model-generated commands. Codex must review and apply returned suggestions.

After registration, new Codex tasks load the server. An already-running task may need MCP reconnection or a fresh task to expose the new tools; configuration success alone does not prove the current tool catalog refreshed.

Verification:

```sh
node tests/local-model-mcp-test.mjs
LOCAL_MODEL_BASE_URL=http://YOUR_HOST:8000/v1 LOCAL_MODEL_ID=YOUR_MODEL node tests/local-model-mcp-test.mjs --live
```

The fixture verifies protocol initialization/discovery, model locking, image payloads, capacity release, cancellation and failures. The live check sends a generated red image plus arithmetic task through a real MCP subprocess and checks the returned answer. No personal screenshots are used.

## Fresh-context review workflow

Version 1.1 keeps the original single-call path. For nontrivial code, the coordinator can use this bounded chain:

1. `submit_task({ task, context, role: "generate" })`, then collect all `wait_task` pages.
2. `submit_task({ task: "Review correctness and regressions", role: "review", parent_task_id: candidateId })`, then collect the report.
3. Independently check findings and execute appropriate real tests. If needed, use `submit_task({ task: confirmedDefectsAndTestEvidence, role: "revise", parent_task_id: reviewId })`, then review that replacement candidate in a new call.

Review receives original requirements, original material/images and the candidate's final text. It does not receive the model's private reasoning or previous review reports. Revision also receives the parent review, but is instructed to address only coordinator-confirmed findings. Do not pass `context`, `image_paths`, or `image_data` to review/revise, even empty ones: the original inputs are inherited. Necessary new evidence belongs in `task`.

The server rejects wrong parent roles, non-completed/truncated parents, and more than two revision attempts per root. Attempts are reserved synchronously before model work; failures and cancellations do not refund them. Four concurrent jobs are shared across callers. Completed parents release their execution slots. The 15-minute deadline is per call; there is no automatic loop. The coordinator stops on acceptance, no progress, cancellation, truncation, or the repair limit, and must not create new roots to evade it.

Snapshots include `role`, `root_task_id`, `parent_task_id`, `repair_attempt`, and `verification: "not_run"`. `completed` means model text is available, not that a patch was applied or tests passed. Non-stop completions have terminal state `incomplete` with partial output retained; empty final text without truncation has state `failed` and retains finish reason/usage for diagnosis. Each record is immutable after completion, output remains paginated, and records are process-local. Call `release_task` only after collecting every required result and finishing the workflow.

The reusable [flash-next-reviewed skill](../skills/flash-next-reviewed/SKILL.md) supplies this workflow to either coordinator. Copy its folder into `~/.codex/skills/` and/or `~/.pi/agent/skills/`. This is a lightweight GVS5H-inspired workflow, not the original competitive-programming harness or a new model provider; no benchmark gains are assumed.

### Pi usage

Register the HTTP server under `flash-next` in `~/.pi/agent/mcp.json`, with `url`, private `headers.Authorization`, `directTools: true`, and `requestTimeoutMs: 65000` (wait calls may last 50 seconds). Keep credentials out of this repository. Existing direct `pennyroyal` model configuration can remain unchanged.

Start a new Pi session or run `/reload` when the current task is idle, then invoke `/skill:flash-next-reviewed` with the task. The main Pi model remains coordinator; the skill dispatches worker stages to the fixed Flash Next MCP. If necessary, `/mcp reconnect flash-next` refreshes schemas. This does not transparently wrap every ordinary model response. Use ordinary Flash Next and this skill on equivalent tasks for a comparison.

## Remote HTTP deployment

Run the same file on the model host with Node 22+ and `--http`:

```sh
LOCAL_MODEL_BASE_URL=http://127.0.0.1:8000/v1 \
LOCAL_MODEL_ID=YOUR_MODEL \
LOCAL_MCP_TOKEN=YOUR_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS \
LOCAL_MCP_PORT=8089 node /path/to/local-model-mcp.mjs --http
```

Use a process supervisor on that host for startup/restart. Credentials belong in a private environment file, never the repository. HTTP serves stateless MCP JSON responses at `/mcp`, requires a bearer token, accepts POST, and does not expose a GET event stream. Configure Codex with `codex mcp add flash-next --url http://YOUR_HOST:8089/mcp --bearer-token-env-var FLASH_NEXT_MCP_TOKEN`; the Codex process must receive that environment variable. Transport is intended for a trusted private LAN; use TLS for other networks.

For a remote MCP, `image_paths` refers to files on the **MCP host**, not the Codex host. Send `image_data` instead for Mac screenshots: an array of `data:image/png;base64,...` (also JPEG/WebP). A task accepts at most four images across both fields. No file-path remapping is implicit.

Add `--http` to either test command to exercise HTTP authentication, discovery, task lifecycle and inline image transport. The live HTTP test still launches the adapter locally while using the real model endpoint; it does not prove deployment on the remote host.

Remote deployment acceptance can target an already-running server without starting a local adapter:

```sh
REMOTE_MCP_URL=http://YOUR_HOST:8089/mcp REMOTE_MCP_TOKEN=YOUR_TOKEN node tests/local-model-mcp-test.mjs --remote
```

Keep the token out of shell history (load it from a private file or environment manager). A local Codex `http_headers` entry can also carry the bearer header when desktop environment propagation is unavailable; protect that config and never commit it.

For a container deployment, mount only the server file read-only, pass environment from a private file, run an unprivileged Node 22+ image, and set Docker's `unless-stopped` restart policy. With host networking, the adapter can reach the inference API over loopback. Set `LOCAL_MCP_HOST` to the desired LAN interface address. This requires no changes to the inference container.

## Reliable final output

MCP calls explicitly default to `reasoning: "on"`, sending `chat_template_kwargs.enable_thinking: true`. The default output budget is 32768 tokens and callers may request up to 65536. Thinking and final text share that budget; this is an upper limit, not a target output length. Omit `max_tokens` to use the larger default instead of carrying forward a small old limit. Set `reasoning: "off"` explicitly for simple tasks if desired; each stage has its own setting. This does not change direct Pi/model clients, context size, or inference server defaults. More output allowance reduces budget pressure but does not guarantee completion or eliminate context limits.

Snapshots report `reasoning`, `elapsed_ms`, `reasoning_characters` (count only), `finish_reason`, `usage`, and `error_code`. Length-limited answers, including empty ones, are `incomplete` with `output_limit`; empty non-truncated answers are `failed` with `empty_final`. Private reasoning is never returned as the deliverable. There are no automatic retries. Split oversized tasks or retry deliberately with a sufficient budget. Completed tasks do not occupy running slots; released results are unavailable for later review.

For the real four-request concurrency and generate/review/revise smoke test, add `--workflow` to the `--remote` acceptance command. It uses a deliberately seeded defect and executes four real JavaScript assertions after repair; this validates plumbing, not comparative model quality.
