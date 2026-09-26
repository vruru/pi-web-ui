#!/usr/bin/env python3
"""Offline, bounded-memory PLE-only FP8 conversion; never writes to source."""
import argparse
import copy
import hashlib
import json
import math
import os
import re
import struct
from pathlib import Path

import torch

DEVICE = "cpu"
PLE = re.compile(r"^(.*\.ngram_embedding)\.shard_(\d+)\.weight$")
WIDTH = {"BOOL": 1, "U8": 1, "I8": 1, "F8_E4M3": 1, "F8_E5M2": 1,
         "I16": 2, "U16": 2, "BF16": 2, "F16": 2, "I32": 4, "U32": 4,
         "F32": 4, "I64": 8, "U64": 8, "F64": 8}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read_exact(f, n):
    data = f.read(n)
    require(len(data) == n, "Truncated file")
    return data


def header(path):
    with path.open("rb") as f:
        n = struct.unpack("<Q", read_exact(f, 8))[0]
        require(0 < n <= 128 * 1024**2, "Invalid header length")
        h = json.loads(read_exact(f, n))
    pos = 0
    for key, value in sorted(((k, v) for k, v in h.items() if k != "__metadata__"), key=lambda kv: kv[1]["data_offsets"]):
        shape, offsets, dtype = value["shape"], value["data_offsets"], value["dtype"]
        require(dtype in WIDTH and all(type(x) is int and x >= 0 for x in shape), f"Invalid type/shape {key}")
        size = math.prod(shape) * WIDTH[dtype]
        require(offsets == [pos, pos + size], f"Invalid offsets {key}")
        pos += size
    require(path.stat().st_size == 8 + n + pos, f"Invalid file size {path.name}")
    return h, 8 + n, pos


def write_header(f, h):
    body = json.dumps(h, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 8)
    f.write(struct.pack("<Q", len(body)))
    f.write(body)


def durable(f):
    f.flush()
    os.fsync(f.fileno())


def drop_pages(f):
    if hasattr(os, "posix_fadvise"):
        os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def digest(path, chunk):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for data in chunks(f, path.stat().st_size, chunk):
            h.update(data)
        drop_pages(f)
    return h.hexdigest()


def chunks(f, size, chunk, out=None):
    since = 0
    while size:
        n = min(size, chunk)
        yield read_exact(f, n)
        size -= n
        since += n
        if since >= 256 * 1024**2:
            if out is not None:
                durable(out)
                drop_pages(out)
            drop_pages(f)
            since = 0


def fp32(raw):
    return torch.frombuffer(bytearray(raw), dtype=torch.bfloat16).to(DEVICE).float()


def choose_scale(amax):
    if amax == 0:
        return torch.tensor([1.0], dtype=torch.bfloat16)
    exact = max(amax / 448.0, torch.finfo(torch.bfloat16).tiny)
    s = torch.tensor([exact], dtype=torch.bfloat16)
    if s.item() < exact:
        s = torch.tensor([int(s.view(torch.int16).item()) + 1], dtype=torch.int16).view(torch.bfloat16)
    require(math.isfinite(s.item()) and s.item() > 0, "Invalid scale")
    return s


def quantize(x, scale):
    y = x / scale
    require(bool(torch.isfinite(y).all()), "Nonfinite quantization input")
    require(float(y.abs().max()) <= 448, "Unexpected clipping")
    return y.clamp(-448, 448).to(torch.float8_e4m3fn)


def rawbytes(t):
    return t.view(torch.uint8).cpu().numpy().tobytes()


def load_index(root):
    index = json.loads((root / "model.safetensors.index.json").read_text())
    wm = index["weight_map"]
    files = {}
    indexed = {}
    for key, name in wm.items():
        require(isinstance(name, str) and Path(name).name == name and name not in ("", ".", ".."), "Unsafe index filename")
        indexed.setdefault(name, set()).add(key)
    for name in sorted(indexed):
        path = root / name
        require(path.is_file() and not path.is_symlink(), f"Expected regular file {name}")
        h, ds, size = header(path)
        require(set(h) - {"__metadata__"} == indexed[name], f"Index/header mismatch {name}")
        files[name] = (h if any(PLE.fullmatch(k) for k in h) else None, ds, size)
    require(sum(v[2] for v in files.values()) == index["metadata"]["total_size"], "Index total_size mismatch")
    return index, files


def convert(src, dst, chunk):
    require(src.is_dir(), "Source directory missing")
    require(not os.path.lexists(dst), "Destination exists")
    stage = dst.with_name(dst.name + ".partial")
    require(not os.path.lexists(stage), "Staging directory exists")
    for target in (dst, stage):
        require(src != target and src not in target.parents, "Destination must be outside source")
    require(dst not in src.parents, "Source inside destination")
    index, files = load_index(src)
    config_hash = digest(src / "config.json", chunk)
    index_hash = digest(src / "model.safetensors.index.json", chunk)
    config = json.loads((src / "config.json").read_text())
    require(isinstance(config.get("text_config"), dict) and config["text_config"].get("ple_embedding_dtype") in (None, "bfloat16"), "Unexpected source PLE configuration")
    ancillary = [p for p in src.iterdir() if not p.name.startswith(".") and p.name not in files and p.name not in ("config.json", "model.safetensors.index.json")]
    for path in ancillary:
        require(path.is_file() and not path.is_symlink(), f"Unexpected source entry {path.name}")
    wm = index["weight_map"]
    matches = [(k, PLE.fullmatch(k)) for k in wm if PLE.fullmatch(k)]
    require(matches and len({m[1] for _, m in matches}) == 1, "Expected exactly one PLE table")
    prefix = matches[0][1][1]
    keys = {k for k, _ in matches}
    require(sorted(int(m[2]) for _, m in matches) == list(range(len(matches))), "Noncontiguous PLE shards")
    scale_key = prefix + ".weight_scale"
    require(scale_key not in wm, "Source already has PLE scale")
    changed = {wm[k] for k in keys}
    scale_file = "ple-fp8-scale.safetensors"
    require(not (src / scale_file).exists(), "Scale filename collision")
    stage.mkdir()  # Fail on destination permission errors before scanning weights.
    original_hashes = {}
    amax = 0.0
    shard_amax = {}
    for name in sorted(changed):
        original_hashes[name] = digest(src / name, chunk)
        h, ds, _ = files[name]
        with (src / name).open("rb") as f:
            for k in sorted(set(h) & keys):
                meta = h[k]
                require(meta["dtype"] == "BF16" and len(meta["shape"]) == 2, f"Not a BF16 PLE matrix {k}")
                begin, end = meta["data_offsets"]
                f.seek(ds + begin)
                maximum = 0.0
                for raw in chunks(f, end - begin, chunk):
                    x = fp32(raw)
                    require(bool(torch.isfinite(x).all()), f"Nonfinite source {k}")
                    maximum = max(maximum, float(x.abs().max()))
                shard_amax[k] = maximum
                amax = max(amax, maximum)
            drop_pages(f)
        print(f"scan {name} absmax={amax}", flush=True)
    scale = choose_scale(amax)
    scale_value = scale.item()
    print(f"scale={scale_value} global_absmax={amax}", flush=True)
    new_index = copy.deepcopy(index)
    new_index["weight_map"][scale_key] = scale_file
    hashes = {}
    for name, (h, ds, size) in files.items():
        with (src / name).open("rb") as inp, (stage / name).open("xb") as out:
            if name not in changed:
                hasher = hashlib.sha256()
                for raw in chunks(inp, (src / name).stat().st_size, chunk, out):
                    out.write(raw)
                    hasher.update(raw)
                original_hashes[name] = hasher.hexdigest()
            else:
                nh = copy.deepcopy(h)
                order = sorted((k for k in h if k != "__metadata__"), key=lambda k: h[k]["data_offsets"])
                offset = 0
                for k in order:
                    n = h[k]["data_offsets"][1] - h[k]["data_offsets"][0]
                    if k in keys:
                        nh[k]["dtype"] = "F8_E4M3"
                        n //= 2
                    nh[k]["data_offsets"] = [offset, offset + n]
                    offset += n
                write_header(out, nh)
                for k in order:
                    begin, end = h[k]["data_offsets"]
                    inp.seek(ds + begin)
                    for raw in chunks(inp, end - begin, chunk, out):
                        out.write(rawbytes(quantize(fp32(raw), scale_value)) if k in keys else raw)
            durable(out)
            drop_pages(inp)
            drop_pages(out)
        hashes[name] = digest(stage / name, chunk)
        if name not in changed:
            require(hashes[name] == original_hashes[name], f"Copy mismatch {name}")
        print(f"write {name}", flush=True)
    with (stage / scale_file).open("xb") as f:
        write_header(f, {scale_key: {"dtype": "BF16", "shape": [1], "data_offsets": [0, 2]}, "__metadata__": {"format": "pt"}})
        f.write(rawbytes(scale))
        durable(f)
    # Copy ancillary regular files independently; never write through links.
    ancillary_hashes = {}
    for path in ancillary:
        with path.open("rb") as inp, (stage / path.name).open("xb") as out:
            for raw in chunks(inp, path.stat().st_size, chunk, out):
                out.write(raw)
            durable(out)
        ancillary_hashes[path.name] = digest(path, chunk)
        require(digest(stage / path.name, chunk) == ancillary_hashes[path.name], "Ancillary copy mismatch")
    config["text_config"]["ple_embedding_dtype"] = "float8_e4m3fn"
    (stage / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    new_index["metadata"]["total_size"] = sum(header(stage / n)[2] for n in set(new_index["weight_map"].values()))
    (stage / "model.safetensors.index.json").write_text(json.dumps(new_index, indent=2) + "\n")
    _, new_files = load_index(stage)
    # Independent disk reread: raw-copy verification plus numerical reconstruction.
    stats = dict(elements=0, nonzero=0, nonzero_to_zero=0, subnormal=0, max_bin=0, squared_source=0.0, squared_error=0.0, max_abs_error=0.0, clipping_rejected=True, nonfinite_rejected=True)
    for name in sorted(changed):
        h, ds, _ = files[name]
        nh, nds, _ = new_files[name]
        with (src / name).open("rb") as inp, (stage / name).open("rb") as out:
            for k, meta in h.items():
                if k == "__metadata__":
                    continue
                begin, end = meta["data_offsets"]
                inp.seek(ds + begin)
                out.seek(nds + nh[k]["data_offsets"][0])
                for raw in chunks(inp, end - begin, chunk):
                    if k not in keys:
                        require(read_exact(out, len(raw)) == raw, f"NonPLE bytes changed {k}")
                        continue
                    x = fp32(raw)
                    stored = read_exact(out, len(raw) // 2)
                    require(stored == rawbytes(quantize(x, scale_value)), f"FP8 roundtrip mismatch {k}")
                    q = torch.frombuffer(bytearray(stored), dtype=torch.uint8).to(DEVICE).view(torch.float8_e4m3fn).to(torch.bfloat16)
                    restored = (q * scale.to(q.device)).float()
                    require(bool(torch.isfinite(restored).all()), "Nonfinite reconstruction")
                    diff = restored - x
                    stats["elements"] += x.numel()
                    stats["nonzero"] += int(torch.count_nonzero(x))
                    stats["nonzero_to_zero"] += int(((x != 0) & (restored == 0)).sum())
                    qa = q.float().abs()
                    stats["subnormal"] += int(((qa > 0) & (qa < 2**-6)).sum())
                    stats["max_bin"] += int((qa == 448).sum())
                    stats["squared_source"] += float(torch.sum(x.double().square()))
                    stats["squared_error"] += float(torch.sum(diff.double().square()))
                    stats["max_abs_error"] = max(stats["max_abs_error"], float(diff.abs().max()))
            drop_pages(inp)
            drop_pages(out)
        require(digest(src / name, chunk) == original_hashes[name], f"Original changed {name}")
        print(f"verify {name}", flush=True)
    for name in set(files) - changed:
        require(digest(src / name, chunk) == original_hashes[name], f"Original changed {name}")
    require(digest(src / "config.json", chunk) == config_hash and digest(src / "model.safetensors.index.json", chunk) == index_hash, "Source config/index changed")
    stats["relative_l2_error"] = math.sqrt(stats["squared_error"] / stats["squared_source"]) if stats["squared_source"] else 0.0
    stats["zeroed_nonzero_fraction"] = stats["nonzero_to_zero"] / max(stats["nonzero"], 1)
    stats["subnormal_fraction"] = stats["subnormal"] / max(stats["elements"], 1)
    report = dict(source=str(src), destination=str(dst), scale=scale_value, global_absmax=amax, per_shard_absmax=shard_amax, source_ple_dtype="BF16", output_ple_dtype="F8_E4M3", metrics=stats, source_hashes=original_hashes, source_config_sha256=config_hash, source_index_sha256=index_hash, output_hashes=hashes, ancillary_hashes=ancillary_hashes, original_total_size=index["metadata"]["total_size"], converted_total_size=new_index["metadata"]["total_size"], complete=True)
    for name in (scale_file, "config.json", "model.safetensors.index.json"):
        report["output_hashes"][name] = digest(stage / name, chunk)
    (stage / "conversion-report.json").write_text(json.dumps(report, indent=2) + "\n")
    for name in ("config.json", "model.safetensors.index.json", "conversion-report.json"):
        with (stage / name).open("rb") as f:
            os.fsync(f.fileno())
    fd = os.open(stage, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)
    require(not os.path.lexists(dst), "Destination appeared during conversion")
    os.rename(stage, dst)
    fd = os.open(dst.parent, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)
    print(json.dumps({"complete": True, "scale": scale_value, "metrics": stats}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("source", type=Path)
    p.add_argument("destination", type=Path)
    p.add_argument("--chunk-mib", type=int, default=8)
    p.add_argument("--device", choices=("cpu", "cuda:0"), default="cpu")
    a = p.parse_args()
    global DEVICE
    DEVICE = a.device
    if DEVICE.startswith("cuda"):
        require(torch.cuda.is_available(), "CUDA unavailable")
    require(1 <= a.chunk_mib <= 32, "chunk-mib must be 1..32")
    torch.set_num_threads(4)
    convert(a.source.resolve(strict=True), a.destination.parent.resolve(strict=True) / a.destination.name, a.chunk_mib * 1024**2)


if __name__ == "__main__":
    main()
