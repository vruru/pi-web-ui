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
