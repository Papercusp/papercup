#!/usr/bin/env python3
"""Grade one arm's collected diffs with the official swe_bench_pro_eval.py (--use_local_docker).

Reads <OUT_DIR>/<arm>.json (perTask + diffs-<arm>/<instance>.diff), builds the predictions JSON
[{instance_id, patch, prefix}], runs the eval over the SAME sample.jsonl, and prints the
per-instance resolved map from eval_results.json. The TS grader (swe-bench-pro.ts) runs this exact
command; we drive it directly here so the grading step is decoupled/resumable from generation.
"""
import hashlib, json, os, re, subprocess, sys

OUT_DIR = os.environ.get("XBENCH_OUT_DIR", "/tmp/xbench-compare-out")
SAMPLE = os.environ.get("XBENCH_SAMPLE", "/tmp/xbench-sample.jsonl")
EVAL_DIR = os.environ.get("PAPERCUSP_SWEBENCH_EVAL_DIR", "/home/dev/.papercusp/bench-harnesses/SWE-bench_Pro-os")
PY = os.environ.get("PAPERCUSP_SWEBENCH_PYTHON", os.path.join(EVAL_DIR, ".venv/bin/python"))
WORKERS = os.environ.get("PAPERCUSP_SWEBENCH_NUM_WORKERS", "4")
DOCKERHUB_USER = os.environ.get("PAPERCUSP_SWEBENCH_DOCKERHUB_USER", "jefzda")

arm = sys.argv[1] if len(sys.argv) > 1 else "hive"
arm_json = os.path.join(OUT_DIR, f"{arm}.json")
diffs_dir = os.path.join(OUT_DIR, f"diffs-{arm}")
grade_out = os.path.join(OUT_DIR, f"grade-{arm}")
os.makedirs(grade_out, exist_ok=True)

frozen = json.loads(os.environ["XBENCH_FROZEN_GRADER"]) if os.environ.get("XBENCH_FROZEN_GRADER") else None

def verify_frozen_grader():
    """Refuse drift before importing or invoking the official scorer."""
    if frozen is None:
        return None
    if frozen.get("family") != "swe-bench-pro" or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", frozen.get("version", "")):
        raise RuntimeError("Frozen official grader source pin is invalid")
    images = frozen.get("images")
    if not isinstance(images, dict) or not images or any(
        not isinstance(uri, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}", uri)
        for uri in images.values()
    ):
        raise RuntimeError("Frozen grader requires immutable task image digests")
    manifest_hash = hashlib.sha256(json.dumps(images, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if manifest_hash != frozen.get("imageDigest"):
        raise RuntimeError("Frozen grader image manifest hash differs")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=EVAL_DIR, text=True).strip()
    if source != frozen["version"]:
        raise RuntimeError("Official grader source differs from its frozen commit")
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--", "swe_bench_pro_eval.py", "helper_code", "run_scripts"], cwd=EVAL_DIR, check=True)
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--", "swe_bench_pro_eval.py", "helper_code", "run_scripts"], cwd=EVAL_DIR, text=True)
    if untracked.strip():
        raise RuntimeError("Official grader has untracked executable inputs")
    sample = os.environ.get("PAPERCUSP_SWEBENCH_CSV")
    if not sample:
        raise RuntimeError("Current grading requires the canonical PAPERCUSP_SWEBENCH_CSV")
    with open(sample, "rb") as stream:
        dataset_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if dataset_hash != frozen.get("datasetSha256"):
        raise RuntimeError("Official grader CSV differs from its frozen dataset")
    return {"sourceCommit": source, "datasetSha256": dataset_hash, "imageDigest": manifest_hash, "images": images}

grader_receipt = verify_frozen_grader()

with open(arm_json) as f:
    arm_data = json.load(f)

# FAIRNESS (benchmark-fairness-fix, Priority 2): OMIT empty-diff / external-or-infra-failed rows from the
# predictions. The grader keys resolved on (FAIL_TO_PASS pass) — for an instance that produced NO real
# submission (empty patch) or whose generation was an EXTERNAL/transient/infra failure (a wall-clock
# timeout, a 429/contention spawn, a drain-unsettled member, a crash), the grader would otherwise apply an
# empty patch and manufacture resolved=false — scoring an unfairly-failed task as a capability fail. We drop
# those rows from predictions instead, so they become resolved=null (no eval_results.json entry) → EXCLUDED
# from the resolved% denominator by the readers (preserved-runs/summarizePreservedRun, _xbench_report,
# run-store), never a fail. Kept in sync with NON_SCORED_STOP_REASONS in types.ts.
NON_SCORED_STOP_REASONS = {"error", "timeout", "infra-failed"}

preds = []
omitted_empty = 0
omitted_infra = 0
for t in arm_data["perTask"]:
    iid = t["instanceId"]
    dp = os.path.join(diffs_dir, f"{iid}.diff")
    patch = ""
    if os.path.exists(dp):
        with open(dp) as df:
            patch = df.read()
    stop_reason = t.get("stopReason")
    gen_error = t.get("generationError")
    if stop_reason in NON_SCORED_STOP_REASONS or gen_error:
        # External/transient/infra failure — never produced a fairly-given submission → exclude (resolved=null).
        omitted_infra += 1
        continue
    if not patch.strip():
        # No real submission for this instance → exclude rather than manufacture a resolved=false.
        omitted_empty += 1
        continue
    preds.append({"instance_id": iid, "patch": patch, "prefix": f"arm-{arm}"})

preds_path = os.path.join(grade_out, "predictions.json")
with open(preds_path, "w") as f:
    json.dump(preds, f)

n_nonempty = sum(1 for p in preds if p["patch"].strip())
print(
    f"[grade] arm={arm} predictions={len(preds)} nonEmptyPatches={n_nonempty} "
    f"omitted(empty-diff={omitted_empty}, infra/transient={omitted_infra}) "
    f"[omitted rows have no conditional grade; assigned-task scoring retains their outcomes]"
)
print(f"[grade] running swe_bench_pro_eval.py over {len(preds)} instances (workers={WORKERS}) ...")

cmd = [
    PY, "swe_bench_pro_eval.py",
    f"--raw_sample_path={SAMPLE}",
    f"--patch_path={preds_path}",
    f"--output_dir={grade_out}/out",
    "--scripts_dir=run_scripts",
    f"--num_workers={WORKERS}",
    f"--dockerhub_username={DOCKERHUB_USER}",
    "--use_local_docker",
]
if frozen is not None:
    if any(p["instance_id"] not in frozen["images"] for p in preds):
        raise RuntimeError("A submitted task has no frozen official grader image")
    cmd[2] = f"--raw_sample_path={os.environ['PAPERCUSP_SWEBENCH_CSV']}"
    # Import the unchanged pinned official module; override only its image URI
    # resolver, so Docker pulls/runs digests instead of mutable registry tags.
    # Official patch application, test execution and scoring stay in that module.
    bootstrap = """import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('swe_bench_pro_eval', 'swe_bench_pro_eval.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
images=json.loads(os.environ['XBENCH_FROZEN_GRADER'])['images']
module.get_dockerhub_image_uri=lambda uid,*args,**kwargs: images[uid]
sys.argv=['swe_bench_pro_eval.py']+sys.argv[1:]
module.main()
"""
    cmd = [PY, "-c", bootstrap] + cmd[2:] + ["--redo"]
print("[grade] cmd:", " ".join(cmd))
if frozen is not None and not preds:
    os.makedirs(f"{grade_out}/out", exist_ok=True)
    with open(f"{grade_out}/out/eval_results.json", "w") as stream:
        json.dump({}, stream)
    proc = subprocess.CompletedProcess(cmd, 0, "No submitted patches; no official grader execution needed.", "")
else:
    proc = subprocess.run(cmd, cwd=EVAL_DIR, capture_output=True, text=True)
if frozen is not None and proc.returncode == 0:
    if verify_frozen_grader() != grader_receipt:
        raise RuntimeError("Official grader inputs changed during evaluation")
    with open(f"{grade_out}/grader-receipt.json", "w") as stream:
        json.dump(grader_receipt, stream, sort_keys=True)
# Tail of stderr/stdout for diagnostics
print("[grade] eval exit:", proc.returncode)
sys.stdout.write(proc.stdout[-3000:])
if proc.returncode != 0:
    sys.stderr.write(proc.stderr[-3000:])
    sys.exit(proc.returncode)

results_path = os.path.join(grade_out, "out", "eval_results.json")
if os.path.exists(results_path):
    with open(results_path) as f:
        results = json.load(f)
    resolved = sum(1 for v in results.values() if v is True)
    pct = f"{resolved/len(results)*100:.1f}%" if results else "unmeasured"
    print(f"\n[grade] arm={arm} CONDITIONAL RESOLVED {resolved}/{len(results)} = {pct}")
    print(json.dumps(results, indent=2))
    # write a normalized summary
    with open(os.path.join(OUT_DIR, f"resolved-{arm}.json"), "w") as f:
        json.dump({"arm": arm, "resolved": resolved, "total": len(results), "perInstance": results}, f, indent=2)
else:
    print(f"\n[grade] NO eval_results.json at {results_path} — grading produced no verdict")
    sys.exit(2)
