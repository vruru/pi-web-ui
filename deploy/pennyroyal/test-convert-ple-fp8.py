"""Small independent safetensors fixtures for the offline converter."""
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

ROOT = Path(__file__).resolve().parent
PREFIX = "model.language_model.layers.1.ple.ple_embedding.ngram_embedding"


def hashes(root):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}


def fixture(path, zero=False, bad=False):
    path.mkdir()
    values = torch.linspace(-5, 5, 3200).reshape(20, 160).bfloat16()
    if zero:
        values.zero_()
    if bad:
        values[0, 0] = float("nan")
    a = {"before": torch.arange(8, dtype=torch.uint8), f"{PREFIX}.shard_0.weight": values[:10].clone(), "tail": torch.tensor([1.125, -3.5], dtype=torch.bfloat16)}
    b = {f"{PREFIX}.shard_1.weight": values[10:].clone()}
    c = {"unrelated": torch.tensor([33, 42], dtype=torch.int64)}
    wm, total = {}, 0
    for filename, tensors in (("mixed.safetensors", a), ("ple.safetensors", b), ("other.safetensors", c)):
        save_file(tensors, path / filename, metadata={"format": "pt"})
        for key, value in tensors.items():
            wm[key] = filename
            total += value.numel() * value.element_size()
    (path / "model.safetensors.index.json").write_text(json.dumps({"metadata": {"total_size": total}, "weight_map": wm}))
    (path / "config.json").write_text(json.dumps({"text_config": {"hidden_size": 2560}, "quantization_config": {"quant_algo": "NVFP4"}}))
    (path / "tokenizer.json").write_text('{"fixture":true}')
    return values, {**a, **b, **c}


with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    for label, zero, bad in (("normal", False, False), ("zero", True, False), ("nonfinite", False, True)):
        source, dest = temp / label, temp / (label + "-fp8")
        values, tensors = fixture(source, zero, bad)
        original = hashes(source)
        proc = subprocess.run([sys.executable, str(ROOT / "convert-ple-fp8.py"), str(source), str(dest), "--chunk-mib", "1", "--device", "cuda:0" if "--cuda" in sys.argv else "cpu"], capture_output=True, text=True)
        assert hashes(source) == original, "Original files changed"
        if bad:
            assert proc.returncode != 0 and not dest.exists()
            print("PASS nonfinite source rejected without source writes")
            continue
        assert proc.returncode == 0, proc.stdout + proc.stderr
        index = json.loads((dest / "model.safetensors.index.json").read_text())
        with safe_open(dest / index["weight_map"][PREFIX + ".weight_scale"], framework="pt") as reader:
            scale = reader.get_tensor(PREFIX + ".weight_scale")
        assert scale.dtype == torch.bfloat16 and scale.shape == (1,)
        assert (scale.item() == 1) if zero else (scale.item() != 1 and scale.item() >= 5 / 448)
        for key, tensor in tensors.items():
            with safe_open(dest / index["weight_map"][key], framework="pt") as reader:
                actual = reader.get_tensor(key)
            if ".shard_" in key:
                assert actual.dtype == torch.float8_e4m3fn
                expected = (tensor.float() / scale.item()).clamp(-448, 448).to(torch.float8_e4m3fn)
                assert torch.equal(actual.view(torch.uint8), expected.view(torch.uint8))
            else:
                assert torch.equal(actual, tensor)
        report = json.loads((dest / "conversion-report.json").read_text())
        assert report["complete"] and report["metrics"]["elements"] == 3200
        assert report["metrics"]["relative_l2_error"] < 0.04
        assert not any(p.is_symlink() for p in dest.iterdir())
        assert hashes(source) == original
        again = subprocess.run([sys.executable, str(ROOT / "convert-ple-fp8.py"), str(source), str(dest)], capture_output=True)
        assert again.returncode != 0 and hashes(source) == original
        print(f"PASS {label}: independent reader, nonunit scale, unchanged tensors, original preservation, destination guard")
