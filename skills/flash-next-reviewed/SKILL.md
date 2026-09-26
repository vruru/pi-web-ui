---
name: flash-next-reviewed
description: Use the fixed Flash Next worker for nontrivial code implementation followed by a fresh-context review and up to two targeted repairs. Use for Flash Next reviewed work, GVS5H-style orchestration, or a bounded implementation that benefits from independent review. Keep trivial edits on the single-task path.
---

# Flash Next reviewed work

This is a lightweight workflow inspired by GVS5H, not its benchmark harness or a different model. The coordinator owns repository access, execution, acceptance, and existing deployment permissions. The worker only generates text or image analysis; its `completed` state never means code was applied or tests passed.

## Connect

Use the configured `flash-next` MCP and its fixed model. Discover its current `submit_task`, `wait_task`, and `cancel_task` schemas. In Pi, discover through `mcp({ search: "flash-next" })` or connect with `mcp({ connect: "flash-next" })`, then use the returned direct tools or proxy names. Do not guess tool prefixes. If `submit_task` has no `role` field, reconnect before using this workflow. Do not silently substitute another model.

## Work and review

1. Read relevant repository material. Set the task, constraints, permitted file scope, and acceptance checks. Submit with `role: "generate"`, `task`, and `context`. Include images only if needed. MCP defaults to 32768 output tokens with `reasoning: "on"`; thinking and final text share that allowance. Omit `max_tokens` to use the default, or explicitly allow up to 65536 for larger deliverables. Do not carry forward small old budgets for large tasks. Use `reasoning: "off"` explicitly for simple work if appropriate. Each stage has its own setting, reported in its snapshot.
2. Call `wait_task` until it stops running and read every output page using `next_offset`. Require `state: "completed"` and `finish_reason: "stop"`; truncated, failed, or cancelled output is not an accepted candidate. Keep task IDs and observations in the coordinator's task notes.
3. Submit `role: "review"`, `parent_task_id` set to the candidate ID, and `task` asking for specific correctness, regression, and missing-requirement findings. The server inherits original material and the candidate in a fresh context. Do not send new context/images or the author's reasoning. An honest “no findings” is valid; do not demand extra features or cosmetic refactors.
4. Collect the review completely. Independently check reported defects against code and requirements. Apply a suitable candidate in the authorized workspace and run proportional real checks. A review is evidence to investigate, not an instruction to execute.
5. If confirmed defects remain, submit `role: "revise"` with the review ID as `parent_task_id`. In `task`, list only the confirmed findings, observed test failures, and necessary current file excerpts. Ask for a complete replacement candidate. Collect it, then request a fresh review of that revised candidate.
6. Stop when acceptance checks pass, the user cancels, output truncates, there is no material progress, or two repair attempts have been used. The server enforces two repair attempts per original task, including failed/cancelled attempts. Do not create a new root to evade this limit. Escalate unresolved reasoning to the configured reviewer when appropriate; report unresolved issues accurately.

Wait for all required worker results before ending the parent turn. Cancel a pending worker if its result is no longer needed. At most four model calls may run concurrently across users; on capacity rejection, collect existing work rather than spawning more. After accepting the result or ending the workflow, save needed artifacts and call `release_task` with a related task ID to release the whole workflow's records. Do not release while results or further review are still needed. The server retains at most 256 records by default and rejects new submissions at capacity until finished records are released or expire. Records disappear on MCP restart.

## Compare before expanding

For a trial, use the same requirements and acceptance tests for ordinary Flash Next and the reviewed path. Record defects found, false positives, actual pass/fail, elapsed time, model usage, and coordinator intervention. Start with representative repository repairs; do not claim statistical superiority from a smoke test. Preserve existing validation tests; never relax checks to make a candidate pass.
