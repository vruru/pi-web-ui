# Flash Next runtime overlay

These files maintain the local Flash Next deployment used by the model MCP. They do not modify the Pi web application or contain deployment credentials.

The launch script is an overlay for `ghcr.io/jpezzulli/sglang-rtxpro6000` image digest `sha256:7103728d3d5568e7fe56d684c179632dae5ccd62df48d20807e1cc779867b00c` (runtime revision `2d6689abdac6f200091e9aa1ae65e95b86d9dd82`). It expects the vendor's sibling helper scripts, templates and FR-Spec map. Mount it over `/opt/pennyroyal/configs/pennyroyal/serve-flash-next-frspec.sh`.

## Model identity

The launcher has no hard-coded tokenizer or token-map checksum allow-list. Required-file checks remain. Hashes are still computed as cache identity inputs: changing weights/tokenizer must not accidentally reuse another model's cache. Removing the allow-list does not guarantee arbitrary NVFP4 architectures or token vocabularies are compatible with this Flash Next profile.

## BF16 PLE host allocation

`ple-host-allocation.patch` changes only construction of the offloaded PLE table: create its temporary metadata on the meta device and let the existing wrapper allocate the actual pinned host storage. The tiny scale buffer stays on CUDA. Normal GPU embedding construction is unchanged. Checkpoint precision is unchanged.

Apply the patch to a local copy of the pinned image's `python/sglang/srt/models/qwen4_exp.py`, compile/check locally, then upload the resulting runtime file and mount it read-only at `/opt/pennyroyal/python/sglang/srt/models/qwen4_exp.py`. Do not blindly apply to a different image revision. Keep the original compose and launch script for rollback.

Swift's BF16 PLE table is approximately 95.37 GiB. PyTorch's default pinned allocator would round this up to 128 GiB. Set:

```yaml
PYTORCH_ALLOC_CONF: "expandable_segments:True,pinned_max_round_threshold_mb:1024,pinned_max_cached_size_mb:1024"
HICACHE_ENABLED: "false"
```

The matching cache threshold also avoids retaining these very large allocations in the pinned free list. The launcher respects allocator configuration supplied by the environment. RAM availability must still be checked before deployment. On the 128 GB host, even a 2 GiB HiCache failed the runtime's available-memory reserve check after weights and MTP loaded, so this deployment disables the optional host/disk prefix cache. GPU KV cache, context size, concurrency and NEXTN remain unchanged. `HICACHE_ENABLED` defaults to `true` for existing deployments.

## Validation

Run `bash -n serve-flash-next-frspec.sh` locally. Run `test-ple-host-allocation.py` using the image's Python with GPU access to check both BF16 and FP8 storage and GPU gathers. After model startup, independently check health, the served model identity, actual launch parameters, real text/tool/image requests and concurrent worker requests. A successful small embedding test is not a full model load test, and a configured context size is not proof that its full length was stress-tested.

## Offline FP8 PLE checkpoint

`convert-ple-fp8.py SOURCE DESTINATION --device cuda:0` creates a separate checkpoint. Use `--device cpu` when the model GPU is unavailable. Source and destination must be separate directories; existing destinations and staging directories are rejected. In a container, mount the source read-only and provide a writable output parent. Check its user permissions before running. The source checkpoint remains the rollback copy.

The converter handles one logical PLE table split across numbered shards. It scans all BF16 shards for a global absolute maximum, divides by 448, and rounds the positive scale upward to a representable BF16 value. It stores PLE as `F8_E4M3`, adds the loader's `weight_scale` tensor, and sets only `text_config.ple_embedding_dtype`. It makes independent copies of unchanged files, preserves non-PLE tensor bytes in mixed files, rebuilds index byte counts, and verifies the written data before publishing the staging directory. This requires space for an entire converted checkpoint, not just the changed table.

Conversions use bounded chunks (8 MiB by default), periodically flush writes, reject nonfinite data and clipping, and record reconstruction error, zero/subnormal counts, and hashes in `conversion-report.json`. Runtime data, models and generated reports are not Git artifacts. The converter performs quantization, not training or correction of learned reasoning mistakes.

Run `test-convert-ple-fp8.py` in the image's Python for independent safetensors-reader fixtures. Add `--cuda` to exercise GPU conversion. `test-ple-host-allocation.py` also checks the exact nonunit scale key using the real model buffer loader and a GPU gather.

## Controlled comparison and output diagnostics

`benchmark-ple.py --url API_BASE --label LABEL --output LOCAL_REPORT` runs 12 oracle-scored text, code, structured extraction, tool and image cases, plus a fixed 512-token decode probe. It warms each case then records three cold-cache repeats. Failed cache flushes wait for an idle window rather than silently using a warm cache. Outputs, timing, usage and raw stream events are recorded locally. The same default suite and settings must be used for BF16 and FP8 comparisons.

`--extended` adds four code syntax/name checks; these use Python parsing and `node --check`, never execute generated code, and do not prove semantic correctness. `--diagnostics` separately tests explicit JSON schemas for the two format-sensitive cases and higher reasoning effort for the interval case. These changed requests are diagnostic evidence, not weight-quality improvements.

`--code-only --temperature 1` checks the same code prompts under sampled generation. The default temperature remains zero for the frozen comparison. Reports retain the chosen temperature, complete responses and stream deltas; a syntactically valid final answer does not imply that intermediate reasoning contained no self-corrections.

`MTP_ENABLED=false` omits NEXTN launch flags for a separate diagnostic launch; the default remains `true`. Compare MTP on/off with all other settings held fixed before attributing generation mistakes to speculation. Model outputs can differ despite temperature zero, so small smoke samples cannot establish general accuracy or absence of typos.

Placement experiments are documented in `../../docs/swift-fp8-ple-results-2026-09-26.md`. `benchmark-ple-placement.py` compares the native gather with a small pinned/GPU synthetic table; run it only on an idle model GPU with at least 2 GiB free. It does not implement a cache or establish end-to-end speedup. Use a bounded runtime GPU profile to establish the gather's actual share before changing placement.

## JSON schema after reasoning

`json-root-whitespace.patch` applies to the pinned runtime's `python/sglang/srt/constrained/xgrammar_backend.py`. Its JSON schema compiler rejects whitespace before the root value even with `any_whitespace=True`. At the reasoning/content boundary this can force a different first token: a reproduced string-valued task returned `">"` despite reasoning that correctly derived `"NEG_ZERO"`. The issue also reproduced with MTP disabled.

The patch composes at most eight RFC JSON whitespace characters before the original schema grammar. It preserves value constraints, adds no trailing-whitespace loop, and leaves builtin JSON, regex, EBNF, structural tags and `any_whitespace=False` unchanged. `SGLANG_JSON_ROOT_WHITESPACE=0` disables the added prefix. JSON consumers must parse JSON rather than compare the untrimmed raw response.

Apply to a local copy of the pinned image file, check it, upload the resulting runtime file and bind-mount it read-only at its original container path. Run `test-json-root-whitespace.py /model` in the runtime against the actual tokenizer; it covers valid/invalid values, bounded whitespace, recursive schemas, patterns and rollback behavior. `test-json-root-whitespace-api.py --url API_BASE --output LOCAL_REPORT` records live reasoning/schema regressions with logprobs. These checks do not establish that general model reasoning or code generation is error-free.

The production service is managed by systemd. Stop/start its service unit when changing compose or mounted files; stopping the container alone may cause the unit to restart it. Confirm actual mounts, health, served identity, capacity, MTP and MCP requests after restarting.
