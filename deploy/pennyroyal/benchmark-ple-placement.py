"""Isolated gather microbenchmark, not a full model or a cache hit-rate test."""
import json
import statistics

import torch
from sglang.srt.models.qwen4_exp import _gather_ple_embedding_from_pinned_kernel


torch.set_num_threads(2)
torch.manual_seed(42)
free, total = torch.cuda.mem_get_info()
assert free > 2 * 1024**3, "Keep at least 2 GiB free before starting this probe"
rows, width, inner = 1 << 20, 160, 16
host = torch.empty((rows, width), dtype=torch.float8_e4m3fn, pin_memory=True)
host.fill_(1)
device = host.cuda()
results = []
for count in (16, 64, 256, 4096, 65536):
    ids = torch.randint(rows, (count,), device="cuda")
    out = torch.empty((count, width), dtype=torch.bfloat16, device="cuda")

    def gather(weight):
        _gather_ple_embedding_from_pinned_kernel[(count,)](
            weight.data_ptr(), ids, out, embedding_dim=width,
            tp_vocab_start=0, tp_vocab_end=rows, is_fp8=True, BLOCK_D=256,
        )

    timings = {}
    for name, weight in (("pinned_host", host), ("gpu", device)):
        for _ in range(3):
            gather(weight)
        torch.cuda.synchronize()
        assert bool((out == 1).all())
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            for _ in range(inner):
                ids.random_(0, rows)
                gather(weight)
        samples = []
        for _ in range(5):
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record()
            for _ in range(10):
                graph.replay()
            end.record()
            end.synchronize()
            samples.append(start.elapsed_time(end) * 1000 / (inner * 10))
        timings[name] = statistics.median(samples)
        del graph
    results.append({"rows_per_gather": count, "table_mib": host.numel() / 2**20,
                    "median_us_including_id_rng": timings,
                    "host_minus_gpu_us": timings["pinned_host"] - timings["gpu"]})
    print(json.dumps(results[-1]), flush=True)
print(json.dumps({"results": results, "limitations": "160 MiB synthetic table, same native gather, random row IDs; does not measure real workload locality, 47.7 GiB table TLB behavior, or end-to-end speedup."}))
