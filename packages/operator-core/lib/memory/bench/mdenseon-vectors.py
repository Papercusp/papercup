"""Generate pinned mDenseOn vectors for embedder-eval-cli --vectors.

Run in an isolated environment with torch (CPU) and sentence-transformers.
This is experimental Python inference, not a Transformers.js sidecar export.
The conventional Vitest suite validates the manifest before scoring it.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import resource
import time

import torch
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer

MODEL = "lightonai/mDenseOn"
REVISION = "a5fdb000f7a21da96c3bddde3a782ef777316df3"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--corpus", choices=["memory", "prose", "both"], default="both")
    args = parser.parse_args()
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    model = SentenceTransformer(MODEL, revision=REVISION, device="cpu",
                                model_kwargs={"attn_implementation": "sdpa"})
    # Model loading and warmup are reported separately from inference.
    for kind in ["query", "document"]:
        model.encode(["warmup"], prompt_name=kind, normalize_embeddings=True)
    cache = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    report = {"name": "mdenseon-python", "model": MODEL, "revision": REVISION,
              "runtime": "python-sentence-transformers-cpu-fp32", "dimensions": 768,
              "pooling": "cls", "prompts": dict(model.prompts),
              "versions": {p: importlib.metadata.version(p) for p in ["torch", "transformers", "sentence-transformers"]},
              "loadSeconds": time.perf_counter() - started,
              "assetBytes": sum(p.stat().st_size for p in cache.rglob("*") if p.is_file()),
              "suites": {}}
    fixtures = Path(__file__).resolve().parent / "fixtures"
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    for corpus in (["memory", "prose"] if args.corpus == "both" else [args.corpus]):
        prefix = "prose-" if corpus == "prose" else ""
        corpus_file = fixtures / f"{prefix}corpus.v1.json"
        gold_file = fixtures / f"{prefix}gold-set.v1.json"
        entries = json.loads(corpus_file.read_text())["entries"]
        queries = json.loads(gold_file.read_text())["queries"]
        suite = {"corpusSha256": hashlib.sha256(corpus_file.read_bytes()).hexdigest(),
                 "goldSha256": hashlib.sha256(gold_file.read_bytes()).hexdigest(),
                 "keys": [e["key"] for e in entries], "queryIds": [q["id"] for q in queries]}
        for kind, texts, vector_key, time_key in [
            ("document", [e["text"] for e in entries], "docVectors", "docSeconds"),
            ("query", [q["query"] for q in queries], "queryVectors", "querySeconds")]:
            vectors = []
            t0 = time.perf_counter()
            for index, text in enumerate(texts):
                vector = model.encode([text], prompt_name=kind, normalize_embeddings=True,
                                      convert_to_numpy=True, batch_size=1)[0]
                vectors.append(vector.tolist())
                if (index + 1) % 50 == 0:
                    print(f"[{corpus}/{kind}] {index + 1}/{len(texts)}", flush=True)
            suite[vector_key] = vectors
            suite[time_key] = time.perf_counter() - t0
        suite["peakRssMB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        report["suites"][corpus] = suite
        # Each completed suite survives interruption of the next pass.
        temporary = out.with_suffix(out.suffix + ".tmp")
        temporary.write_text(json.dumps(report))
        temporary.replace(out)
        print(f"completed {corpus}: {suite['docSeconds']:.1f}s docs, {suite['querySeconds']:.1f}s queries -> {out}", flush=True)


if __name__ == "__main__":
    main()
