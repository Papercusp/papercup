# SWE-bench Pro Task Subset Selection

This document describes the selection methodology for the SWE-bench Pro task subsets used for the benchmark credibility roadmap (P-004, D-003).

## Overview

Two task subsets were created from the 731 SWE-bench Pro public dataset:
- **subset-50.txt**: 50 selected tasks
- **subset-150.txt**: 150 selected tasks

## Selection Methodology

**Method:** Random uniform sampling (non-stratified)

**Fixed Seed:** 42 (for reproducibility)

**Algorithm:**
1. Load the full 731 SWE-bench Pro dataset from `helper_code/sweap_eval_full_v2.jsonl`
2. Load the 11-task pilot set from `/tmp/xbench-chosen-ids.txt`
3. Create a pool of 720 tasks (excluding the 11 pilots to avoid duplicates)
4. Set random seed to 42 for reproducibility
5. Randomly sample 139 tasks from the pool
6. Create subset-50 by combining 11 pilots + first 39 random tasks, then shuffle
7. Create subset-150 by combining 11 pilots + all 139 random tasks, then shuffle
8. This ensures the superset property: 11 pilots ⊂ 50 ⊂ 150 ⊂ 731

## Superset Property

The subsets satisfy the superset constraint: **11 ⊂ 50 ⊂ 150 ⊂ 731**

- All 11 pilot tasks appear in both subsets
- All 50 tasks in subset-50.txt appear in subset-150.txt
- All 150 tasks in subset-150.txt are drawn from the 731 total

This ensures:
- Downward compatibility (50-task runs can be compared to 150-task runs)
- Pilot representativeness (same pilot tasks across all runs)
- Statistical validity (non-cherry-picked selection with fixed seed)

## Verification

The selection was verified to ensure:
- ✓ All 11 pilot tasks present in both subsets
- ✓ All 50 tasks in subset-50 present in subset-150
- ✓ Seed is fixed and documented (42)
- ✓ Selection is reproducible (same seed → same tasks)

## Usage

To verify or recreate the subsets, run:

```bash
python select-swe-bench-subsets.py
```

The script will:
1. Load the full 731-task dataset
2. Load the 11-task pilot IDs
3. Generate both subsets with seed=42
4. Output subset-50.txt and subset-150.txt

## Files

- **subset-50.txt** - 50 task instance IDs (one per line)
- **subset-150.txt** - 150 task instance IDs (one per line)
- **select-swe-bench-subsets.py** - Selection script with documented seed and methodology
- **SWE-BENCH-SUBSET-README.md** - This file

## Data Files and Docker Images

### Source Data Files

The full SWE-bench Pro dataset is located in:
- **Full 731-task dataset:** `~/.papercusp/bench-harnesses/SWE-bench_Pro-os/helper_code/sweap_eval_full_v2.jsonl`
- **Docker image mappings:** Available in the same directory structure

### Subset Data Generation

For benchmark runs, subset-specific JSONL files can be generated from the full dataset by:
1. Loading the full `sweap_eval_full_v2.jsonl`
2. Filtering to only include tasks whose `instance_id` appears in the corresponding subset file
3. Saving filtered records to a new JSONL file

**Recommended naming convention:**
- `sweap_eval_subset_50_v2.jsonl` - JSONL containing only the 50 selected tasks
- `sweap_eval_subset_150_v2.jsonl` - JSONL containing only the 150 selected tasks

### Docker Images

Docker image references for each task are included in the source JSONL files. When generating subset JSONL files, the corresponding Docker image URIs will be preserved for each task instance.

See the benchmark run documentation for detailed instructions on using these subset files with the evaluation pipeline.

## References

- Benchmark Credibility Roadmap: `benchmark-credibility-roadmap-2026-06-16`
  - P-004: Pre-register 50+150 task subsets with fixed seed
  - D-003: Credibility requirements for non-cherry-picked selection
