# Local model MCP worker

`bin/local-model-mcp.mjs` is a standalone Node 22+ stdio MCP server. Codex owns orchestration and review; a fixed OpenAI-compatible model supplies analysis, code, patches and image interpretation. No Pi/web service restart or Python/npm dependencies are needed.

Configure `LOCAL_MODEL_BASE_URL` (including `/v1`), `LOCAL_MODEL_ID`, and optionally `LOCAL_MODEL_API_KEY` in the local environment. Never commit endpoint credentials. The tool cannot select another model or silently fall back.

Example registration (replace the placeholders with your endpoint/model):

```sh
codex mcp add flash-next --env LOCAL_MODEL_BASE_URL=http://YOUR_HOST:8000/v1 --env LOCAL_MODEL_ID=YOUR_MODEL -- /absolute/path/to/node /absolute/path/to/local-model-mcp.mjs
```

Tools:

- `model_status`: check the configured model is listed by the endpoint.
- `submit_task`: supply `task`, optional source text in `context`, optional `image_paths` (up to four absolute PNG/JPEG/WebP files, each at most 10 MiB), and optional `max_tokens` (64–16384, default 8192). Immediately returns a task ID. Only the explicitly attached files are read and uploaded. The model has no independent filesystem or execution tools.
- `wait_task`: supply `task_id`, optional `wait_seconds` (0–50) and `offset`. Repeat until completed/failed/cancelled. Output is returned in 24000-character pages; follow `next_offset`. `finish_reason: length` means the response is truncated and may need a follow-up task.
- `cancel_task`: abort the HTTP request; backend cancellation latency depends on the inference server.

Each MCP process allows two running jobs, with a 15-minute deadline per job. Completed jobs do not occupy running slots. Completed output is retained in memory for up to an hour (pruned on new submissions) and up to 32 records. Restarting/disconnecting the MCP process cancels jobs and loses results. There is no automatic wakeup of a finished Codex turn: the coordinator must explicitly wait and collect required results before ending. This adapter does not automatically edit files or execute model-generated commands. Codex must review and apply returned suggestions.

After registration, new Codex tasks load the server. An already-running task may need MCP reconnection or a fresh task to expose the new tools; configuration success alone does not prove the current tool catalog refreshed.

Verification:

```sh
node tests/local-model-mcp-test.mjs
LOCAL_MODEL_BASE_URL=http://YOUR_HOST:8000/v1 LOCAL_MODEL_ID=YOUR_MODEL node tests/local-model-mcp-test.mjs --live
```

The fixture verifies protocol initialization/discovery, model locking, image payloads, capacity release, cancellation and failures. The live check sends a generated red image plus arithmetic task through a real MCP subprocess and checks the returned answer. No personal screenshots are used.

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
