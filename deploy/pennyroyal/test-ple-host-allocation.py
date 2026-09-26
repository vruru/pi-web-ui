"""Run in the pinned SGLang image with a GPU; does not load a model."""

import torch

from sglang.srt.layers.vocab_parallel_embedding import VocabParallelEmbedding
from sglang.srt.models.qwen4_exp import (
    Qwen4ExpPinnedHostEmbedding,
    Qwen4ExpForConditionalGeneration,
)


for dtype in (torch.bfloat16, torch.float8_e4m3fn):
    with torch.device("cuda"):
        with torch.device("meta"):
            embedding = VocabParallelEmbedding(
                256, 160, params_dtype=dtype,
                output_dtype=torch.bfloat16, enable_tp=False,
            )
        embedding.register_buffer("weight_scale", torch.ones(1, dtype=torch.bfloat16))
        assert embedding.weight.is_meta
        host = Qwen4ExpPinnedHostEmbedding(embedding)
    assert host.weight.device.type == "cpu" and host.weight.is_pinned()
    assert host.weight.dtype == dtype and host.weight_scale.device.type == "cuda"
    assert not any(t.is_meta for t in (*host.parameters(), *host.buffers()))
    # Exercise different rows so stale or constant gathers cannot pass.
    host.weight.data.zero_()
    host.weight.data[255].fill_(2)
    ids = torch.tensor([0, 255], device="cuda")
    expected = torch.stack((torch.zeros(160), torch.full((160,), 2))).cuda().bfloat16()
    assert torch.equal(host.gather(ids), expected)
    print(f"{dtype}: meta allocation, pinned storage and CUDA gather PASS")

# The converted checkpoint's scale must be consumed by the real buffer loader.
name = "model.language_model.layers.1.ple.ple_embedding.ngram_embedding.weight_scale"
scale = torch.tensor([0.0123], dtype=torch.bfloat16)
loaded = set()
assert Qwen4ExpForConditionalGeneration._load_qwen4_exp_ple_buffer(
    None, name, scale, {name: host.weight_scale}, loaded
)
assert name in loaded and torch.equal(host.weight_scale.cpu(), scale)
scaled = host.gather(ids) * host.weight_scale
assert torch.equal(scaled.cpu(), expected.cpu() * scale)
assert not torch.equal(scaled, expected)
print("Nonunit BF16 scale: real loader key, buffer copy and scaled GPU gather PASS")
