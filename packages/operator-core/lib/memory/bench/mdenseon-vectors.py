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
import shutil
import time

import numpy as np
import torch
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer
from mdenseon_config import apply_pinned_rope

MODEL = "lightonai/mDenseOn"
REVISION = "a5fdb000f7a21da96c3bddde3a782ef777316df3"
VECTOR_COSINE_FLOOR = 0.99999
VECTOR_MAX_ABS_ERROR = 3e-5


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sample_indices(length, count):
    """Stable coverage across a fixture without baking its current size into the validator."""
    if length <= count:
        return list(range(length))
    return sorted({round(i * (length - 1) / (count - 1)) for i in range(count)})


def normalized_cls(hidden_state):
    vectors = np.asarray(hidden_state[:, 0, :], dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(norms == 0) or not np.isfinite(vectors).all():
        raise ValueError("model produced a non-finite or zero-norm CLS vector")
    return vectors / norms


def compare_vectors(actual, expected, labels):
    actual = np.asarray(actual, dtype=np.float32)
    expected = np.asarray(expected, dtype=np.float32)
    if actual.shape != expected.shape:
        raise ValueError(f"vector shape mismatch: actual {actual.shape}, expected {expected.shape}")
    cosines = np.sum(actual * expected, axis=1)
    errors = np.max(np.abs(actual - expected), axis=1)
    return {
        "count": len(labels),
        "minimumCosine": float(np.min(cosines)),
        "maximumAbsoluteError": float(np.max(errors)),
        "worstCosineLabel": labels[int(np.argmin(cosines))],
        "worstAbsoluteErrorLabel": labels[int(np.argmax(errors))],
        "cases": [
            {"label": label, "cosine": float(cosine), "maximumAbsoluteError": float(error)}
            for label, cosine, error in zip(labels, cosines, errors)
        ],
    }


def run_onnx_vectors(session, tokenizer, texts, batch_size=8):
    vectors = []
    token_records = []
    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        encoded = tokenizer(batch, padding=True, truncation=True, max_length=8192,
                            return_tensors="np")
        inputs = {name: np.asarray(encoded[name], dtype=np.int64)
                  for name in ("input_ids", "attention_mask")}
        hidden = session.run(["last_hidden_state"], inputs)[0]
        vectors.extend(normalized_cls(hidden))
        for row, mask in zip(inputs["input_ids"], inputs["attention_mask"]):
            length = int(mask.sum())
            token_records.append({"length": length, "inputIds": row[:length].tolist()})
    return np.asarray(vectors, dtype=np.float32), token_records


def run_torch_vectors(model, tokenizer, texts):
    encoded = tokenizer(texts, padding=True, truncation=True, max_length=8192,
                        return_tensors="pt")
    model_inputs = {name: encoded[name] for name in ("input_ids", "attention_mask")}
    with torch.no_grad():
        hidden = model(**model_inputs).last_hidden_state.detach().cpu().numpy()
    return normalized_cls(hidden), [
        {"length": int(mask.sum()), "inputIds": ids[:int(mask.sum())].tolist()}
        for ids, mask in zip(encoded["input_ids"], encoded["attention_mask"])
    ]


def load_frozen_cases(repo_root):
    report_path = repo_root / ".papercusp/bench-reports/candidates-2026-09-30-mdenseon-vectors.json"
    frozen = json.loads(report_path.read_text())
    if frozen.get("model") != MODEL or frozen.get("revision") != REVISION:
        raise ValueError("frozen Python reference is not the pinned mDenseOn revision")
    fixtures = repo_root / "packages/operator-core/lib/memory/bench/fixtures"
    cases = []
    ranking = {}
    for corpus in ("memory", "prose"):
        prefix = "prose-" if corpus == "prose" else ""
        entries = json.loads((fixtures / f"{prefix}corpus.v1.json").read_text())["entries"]
        queries = json.loads((fixtures / f"{prefix}gold-set.v1.json").read_text())["queries"]
        suite = frozen["suites"][corpus]
        if suite["keys"] != [entry["key"] for entry in entries]:
            raise ValueError(f"{corpus} document order differs from the frozen reference")
        if suite["queryIds"] != [query["id"] for query in queries]:
            raise ValueError(f"{corpus} query order differs from the frozen reference")
        for index in sample_indices(len(entries), 6):
            cases.append({"label": f"{corpus}/document/{entries[index]['key']}",
                          "text": f"document: {entries[index]['text']}",
                          "vector": suite["docVectors"][index]})
        for index in sample_indices(len(queries), 6):
            cases.append({"label": f"{corpus}/query/{queries[index]['id']}",
                          "text": f"query: {queries[index]['query']}",
                          "vector": suite["queryVectors"][index]})
        doc_indices = sample_indices(len(entries), 32)
        query_indices = sample_indices(len(queries), 8)
        ranking[corpus] = {
            "docLabels": [entries[index]["key"] for index in doc_indices],
            "docTexts": [f"document: {entries[index]['text']}" for index in doc_indices],
            "docVectors": [suite["docVectors"][index] for index in doc_indices],
            "queryLabels": [queries[index]["id"] for index in query_indices],
            "queryTexts": [f"query: {queries[index]['query']}" for index in query_indices],
            "queryVectors": [suite["queryVectors"][index] for index in query_indices],
        }
    return report_path, frozen, cases, ranking


def validate_rankings(session, tokenizer, ranking):
    results = {}
    for corpus, suite in ranking.items():
        actual_docs, _ = run_onnx_vectors(session, tokenizer, suite["docTexts"])
        actual_queries, _ = run_onnx_vectors(session, tokenizer, suite["queryTexts"])
        expected_docs = np.asarray(suite["docVectors"], dtype=np.float32)
        expected_queries = np.asarray(suite["queryVectors"], dtype=np.float32)
        cases = []
        for index, label in enumerate(suite["queryLabels"]):
            expected_order = np.argsort(-(expected_docs @ expected_queries[index]))[:10]
            actual_order = np.argsort(-(actual_docs @ actual_queries[index]))[:10]
            cases.append({
                "query": label,
                "expectedTop10": [suite["docLabels"][i] for i in expected_order],
                "actualTop10": [suite["docLabels"][i] for i in actual_order],
                "exact": bool(np.array_equal(expected_order, actual_order)),
            })
        results[corpus] = {"candidateDocuments": len(expected_docs), "queries": cases}
    return results


def write_json_atomic(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def load_pinned_tokenizer(snapshot):
    """Load the tokenizer.json without trusting a newer Transformers class alias.

    The pinned snapshot was published with Transformers 5.x and names its generic
    Rust-backed implementation ``TokenizersBackend``. Transformers 4.57 cannot
    resolve that alias through AutoTokenizer even though it can consume the exact
    tokenizer.json. Constructing the stable fast-tokenizer base explicitly keeps
    the bytes and special-token contract pinned across that version boundary.
    """
    from transformers import PreTrainedTokenizerFast

    tokenizer_config = json.loads((snapshot / "tokenizer_config.json").read_text())
    keys = ["bos_token", "eos_token", "unk_token", "pad_token", "mask_token",
            "cls_token", "sep_token", "model_max_length"]
    return PreTrainedTokenizerFast(
        tokenizer_file=str(snapshot / "tokenizer.json"),
        **{key: tokenizer_config[key] for key in keys if key in tokenizer_config},
    )


def load_pinned_config(snapshot):
    from transformers import AutoConfig

    snapshot = Path(snapshot)
    canonical = json.loads((snapshot / "config.json").read_text())
    config = apply_pinned_rope(
        AutoConfig.from_pretrained(snapshot, local_files_only=True), canonical)
    config.reference_compile = False
    return config


def finalize_existing_onnx(directory):
    """Validate and finalize an already-exported graph without re-exporting its weights."""
    import onnx
    import onnxruntime as ort
    from transformers import AutoModel

    root = Path(directory).resolve()
    graph = root / "onnx/model.onnx"
    if not graph.is_file():
        raise ValueError(f"existing ONNX graph not found: {graph}")
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    repo_root = Path(__file__).resolve().parents[5]
    report_path, frozen, frozen_cases, ranking = load_frozen_cases(repo_root)
    thresholds = {"minimumCosine": VECTOR_COSINE_FLOOR,
                  "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR,
                  "top10Ranking": "exact"}
    started = time.perf_counter()
    tokenizer = load_pinned_tokenizer(snapshot)
    config = load_pinned_config(snapshot)
    model = AutoModel.from_pretrained(snapshot, config=config,
                                     attn_implementation="eager", local_files_only=True).eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(graph), sess_options=options,
                                   providers=["CPUExecutionProvider"])

    controlled = [
        ("short-query", "query: parity smoke"),
        ("short-document", "document: deterministic sidecar validation"),
        ("unicode-query", "query: résumé 東京 naïve façade عربي"),
        ("padded-257", "document: " + "token " * 257),
        ("long-1024", "query: " + "retrieval validation token " * 342),
    ]
    controlled_labels = [label for label, _ in controlled]
    controlled_texts = [text for _, text in controlled]
    torch_vectors, torch_tokens = run_torch_vectors(model, tokenizer, controlled_texts)
    onnx_vectors, onnx_tokens = run_onnx_vectors(session, tokenizer, controlled_texts,
                                                 batch_size=len(controlled_texts))
    if torch_tokens != onnx_tokens:
        raise ValueError("token IDs supplied to PyTorch and ONNX differ")
    controlled_result = compare_vectors(onnx_vectors, torch_vectors, controlled_labels)
    controlled_result["tokens"] = [
        {"label": label, **tokens} for label, tokens in zip(controlled_labels, onnx_tokens)
    ]

    frozen_vectors, frozen_tokens = run_onnx_vectors(
        session, tokenizer, [case["text"] for case in frozen_cases])
    frozen_result = compare_vectors(frozen_vectors, [case["vector"] for case in frozen_cases],
                                    [case["label"] for case in frozen_cases])
    frozen_result["tokens"] = [
        {"label": case["label"], **tokens}
        for case, tokens in zip(frozen_cases, frozen_tokens)
    ]
    rankings = validate_rankings(session, tokenizer, ranking)
    ranking_exact = all(case["exact"] for result in rankings.values() for case in result["queries"])
    accepted = (
        controlled_result["minimumCosine"] >= VECTOR_COSINE_FLOOR
        and controlled_result["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        and frozen_result["minimumCosine"] >= VECTOR_COSINE_FLOOR
        and frozen_result["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        and ranking_exact
    )
    limit_tokens = tokenizer("token " * 9000, truncation=True, max_length=8192)["input_ids"]
    if len(limit_tokens) != 8192:
        accepted = False
    validation = {
        "formatVersion": 1,
        "accepted": accepted,
        "model": MODEL,
        "revision": REVISION,
        "graph": {"path": "onnx/model.onnx", "bytes": graph.stat().st_size,
                  "sha256": file_sha256(graph)},
        "thresholds": thresholds,
        "controlledTorchParity": controlled_result,
        "frozenPythonParity": frozen_result,
        "rankingParity": rankings,
        "tokenizerLimit": {"requestedMaxLength": 8192, "observedLength": len(limit_tokens)},
        "frozenReference": {"path": str(report_path.relative_to(repo_root)),
                            "sha256": file_sha256(report_path),
                            "versions": frozen["versions"]},
        "validationVersions": {name: package_version(name) for name in
                               ["torch", "transformers", "onnx", "onnxruntime", "numpy"]},
        "effectiveRope": {"global": config.global_rope_theta,
                          "local": config.local_rope_theta,
                          "parameters": config.rope_parameters},
        "seconds": time.perf_counter() - started,
    }
    write_json_atomic(root / ("validation-report.json" if accepted else "validation-report.failed.json"),
                      validation)
    if not accepted:
        raise ValueError("existing ONNX graph failed the predeclared normalized-vector parity contract")

    config_json = config.to_dict()
    graph_proto = onnx.load(graph, load_external_data=False)
    external_files = sorted({entry.value for tensor in graph_proto.graph.initializer
                             for entry in tensor.external_data if entry.key == "location"})
    if external_files:
        config_json["transformers.js_config"] = {
            "use_external_data_format": {"model.onnx": len(external_files)}}
    write_json_atomic(root / "config.json", config_json)
    shutil.copy2(snapshot / "tokenizer.json", root / "tokenizer.json")
    tokenizer_config = json.loads((snapshot / "tokenizer_config.json").read_text())
    tokenizer_config["model_max_length"] = 8192
    tokenizer_config["tokenizer_class"] = "PreTrainedTokenizerFast"
    write_json_atomic(root / "tokenizer_config.json", tokenizer_config)
    manifest = {"formatVersion": 1, "model": MODEL, "revision": REVISION,
                "dimensions": 768, "pooling": "cls", "normalization": "l2",
                "maxLength": 8192, "output": "last_hidden_state", "weightDtype": "fp32",
                "prompts": {"query": "query: ", "document": "document: "},
                "validation": {"report": "validation-report.json", "thresholds": thresholds},
                "versions": {name: package_version(name) for name in
                             ["torch", "transformers", "optimum", "optimum-onnx", "onnx"]},
                "files": {str(path.relative_to(root)): {"bytes": path.stat().st_size,
                          "sha256": file_sha256(path)}
                          for path in root.rglob("*") if path.is_file()
                          and path.name != "export-manifest.json"}}
    write_json_atomic(root / "export-manifest.json", manifest)
    print(f"validated and finalized existing ONNX export: {root}", flush=True)


def export_onnx(directory):
    """Use Optimum's supported ModernBERT exporter, keeping the Hub snapshot intact."""
    from optimum.exporters.onnx import export
    from optimum.exporters.tasks import TasksManager
    from transformers import AutoModel

    root = Path(directory).resolve()
    if root.exists():
        raise ValueError(f"refusing to overwrite existing export directory: {root}")
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    config = load_pinned_config(snapshot)
    model = AutoModel.from_pretrained(snapshot, config=config,
                                     attn_implementation="eager", local_files_only=True).eval()
    constructor = TasksManager.get_exporter_config_constructor(
        model=model, exporter="onnx", task="feature-extraction", library_name="transformers")
    onnx_config = constructor(model.config)
    graph_dir = root / "onnx"
    graph_dir.mkdir(parents=True)
    graph = graph_dir / "model.onnx"
    print(f"exporting pinned {MODEL}@{REVISION} -> {graph}", flush=True)
    _, outputs = export(model, onnx_config, graph, opset=17, device="cpu",
                        input_shapes={"batch_size": 2, "sequence_length": 32})
    tokenizer = load_pinned_tokenizer(snapshot)
    # SentenceTransformers enforces this independently of tokenizer_config.json.
    tokenizer.model_max_length = 8192
    tokenizer.save_pretrained(root)
    model.config.save_pretrained(root)
    import onnx
    graph_proto = onnx.load(graph, load_external_data=False)
    external_files = sorted({entry.value for tensor in graph_proto.graph.initializer
                             for entry in tensor.external_data if entry.key == "location"})
    if external_files:
        graph_locations = ["model.onnx_data" if i == 0 else f"model.onnx_data_{i}"
                           for i in range(len(external_files))]
        for tensor in graph_proto.graph.initializer:
            for entry in tensor.external_data:
                if entry.key == "location":
                    entry.value = graph_locations[external_files.index(entry.value)]
        for original, target in zip(external_files, graph_locations):
            if original != target:
                (graph_dir / original).rename(graph_dir / target)
        onnx.save(graph_proto, graph)
        exported_config = json.loads((root / "config.json").read_text())
        exported_config["transformers.js_config"] = {
            "use_external_data_format": {"model.onnx": len(external_files)}}
        (root / "config.json").write_text(json.dumps(exported_config, indent=2))
    # The normalized CLS/frozen-reference contract also checks token IDs,
    # padded/long inputs and retrieval rankings. Numerical self-parity alone
    # cannot detect a semantically wrong config shared by torch and ONNX.
    del model
    finalize_existing_onnx(root)


def qualify_incumbent_reference(native_file, out_file):
    """Same pinned ONNX assets; independently maintained Python tokenizer and pooling.

    This is reference qualification, not a second export or a production migration.
    Report shipped and corrected Gemma separately even when shipped loses parity.
    """
    import numpy as np
    import onnxruntime as ort
    native_path = Path(native_file)
    native = json.loads(native_path.read_text())
    request_file = Path(str(native_path) + ".request.json")
    if file_sha256(request_file) != native["requestSha256"]:
        raise ValueError("reference request identity drift")
    request = json.loads(request_file.read_text())
    if native["cases"] != request["cases"] or native["identities"] != request["identities"]:
        raise ValueError("reference native/request recipe drift")
    report = {"formatVersion": 1, "nativeSha256": file_sha256(native_path),
              "requestSha256": native["requestSha256"], "executionProvider": "CPUExecutionProvider",
              "thresholds": {"minimumCosine": VECTOR_COSINE_FLOOR, "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR},
              "versions": {name: package_version(name) for name in ["numpy", "onnxruntime", "tokenizers", "transformers"]},
              "arms": []}
    options = ort.SessionOptions()
    options.intra_op_num_threads = request["execution"]["intraOpNumThreads"]
    options.inter_op_num_threads = request["execution"]["interOpNumThreads"]
    for identity in request["identities"]:
        for asset in identity["files"]:
            if file_sha256(asset["path"]) != asset["sha256"] or Path(asset["path"]).stat().st_size != asset["bytes"]:
                raise ValueError("reference asset identity drift")
        tokenizer = load_pinned_tokenizer(Path(identity["directory"]))
        graph = next(asset["path"] for asset in identity["files"] if asset["path"].endswith("/onnx/model.onnx"))
        session = ort.InferenceSession(graph, sess_options=options, providers=["CPUExecutionProvider"])
        for arm in [a for a in native["arms"] if a["model"] == identity["model"]]:
            if [c["id"] for c in arm["cases"]] != [c["id"] for c in request["cases"]]:
                raise ValueError("reference case coverage/order mismatch")
            results = []
            for case in arm["cases"]:
                encoded = tokenizer(case["promptedText"], padding=True, truncation=True,
                                    max_length=tokenizer.model_max_length, return_tensors="np")
                outputs = dict(zip([x.name for x in session.get_outputs()], session.run(None, {
                    x.name: encoded[x.name].astype(np.int64) for x in session.get_inputs()})))
                if identity["model"] == "harrier":
                    vector = outputs["sentence_embedding"][0]
                else:
                    mask = encoded["attention_mask"].astype(np.float32)[..., None]
                    vector = (outputs["last_hidden_state"] * mask).sum(axis=1)[0] / mask.sum(axis=1)[0]
                vector = vector / np.linalg.norm(vector)
                reference = vector.tolist()
                comparison = compare_vectors([case["vector"]], [reference], [case["id"]])
                tokens_equal = encoded["input_ids"][0].tolist() == case["inputIds"]
                results.append({"id": case["id"], "tokenIdsEqual": tokens_equal,
                                "referenceTokenIds": encoded["input_ids"][0].tolist(), "referenceVector": reference,
                                "nativeParity": comparison,
                                "shippedWorkerParity": compare_vectors([case["shippedVector"]], [case["vector"]], [case["id"]]) if case.get("shippedVector") else None})
            report["arms"].append({"model": arm["model"], "profileId": arm["profileId"],
                                   "tokenizerBackend": arm["tokenizerBackend"], "cases": results})
        del session
    destination = Path(out_file)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x") as handle:
        json.dump(report, handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out")
    parser.add_argument("--export-onnx", help="New local Transformers.js model directory")
    parser.add_argument("--validate-onnx", help="Validate and finalize an existing ONNX export")
    parser.add_argument("--reference-native", help="Qualify incumbent native results against pinned Python ONNX/tokenizer reference")
    parser.add_argument("--corpus", choices=["memory", "prose", "both"], default="both")
    args = parser.parse_args()
    if args.reference_native:
        if not args.out:
            parser.error("--reference-native requires --out")
        qualify_incumbent_reference(args.reference_native, args.out)
        return
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    if args.export_onnx:
        export_onnx(args.export_onnx)
        return
    if args.validate_onnx:
        finalize_existing_onnx(args.validate_onnx)
        return
    if not args.out:
        parser.error("--out is required for a vector run")
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
