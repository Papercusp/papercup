#!/usr/bin/env python3
"""
SWE-bench Pro subset selection script.

Selects 50 and 150 tasks from the full 731 SWE-bench Pro public set with:
- FIXED documented seed (42) for reproducibility
- Superset property: 11 pilot tasks ⊂ 50 ⊂ 150 ⊂ 731
- Random sampling method (uniform, not stratified)

Usage:
  python select-swe-bench-subsets.py

Output:
  subset-50.txt  - 50 selected task IDs (one per line)
  subset-150.txt - 150 selected task IDs (one per line)
"""

import json
import random
from pathlib import Path

# FIXED seed for reproducibility
SEED = 42

# Load the 11-task pilot IDs
pilot_path = Path("/tmp/xbench-chosen-ids.txt")
pilot_ids = [line.strip() for line in pilot_path.read_text().splitlines() if line.strip()]
print(f"Loaded {len(pilot_ids)} pilot task IDs")

# Load the full SWE-bench Pro dataset (731 tasks)
dataset_path = Path.home() / ".papercusp/bench-harnesses/SWE-bench_Pro-os/helper_code/sweap_eval_full_v2.jsonl"
all_tasks = []
with open(dataset_path) as f:
    for line in f:
        if line.strip():
            task = json.loads(line)
            task_id = task.get("instance_id")
            if task_id:
                all_tasks.append(task_id)

print(f"Loaded {len(all_tasks)} tasks from full dataset")

# Verify all pilots are in the full dataset
missing_pilots = [pid for pid in pilot_ids if pid not in all_tasks]
if missing_pilots:
    print(f"WARNING: {len(missing_pilots)} pilot tasks not in dataset: {missing_pilots}")

# Remove pilot tasks from the pool to avoid duplicates when we explicitly include them
pool = [t for t in all_tasks if t not in pilot_ids]
print(f"Pool size (excluding pilots): {len(pool)}")

# Set seed for reproducibility
random.seed(SEED)

# Select tasks ensuring superset property: 11 pilots ⊂ 50 ⊂ 150
# Start with all 11 pilots (guaranteed in all subsets)
# Add 39 random tasks to get 50 total
# Add 100 more random tasks to get 150 total
random_50_pool = random.sample(pool, 139)

# subset_50: 11 pilots + 39 random (first 39 from the random pool)
subset_50 = pilot_ids + random_50_pool[:39]
random.shuffle(subset_50)  # Shuffle to avoid grouping pilots

# subset_150: 11 pilots + 139 random (all from the random pool)
subset_150 = pilot_ids + random_50_pool
random.shuffle(subset_150)  # Shuffle to avoid grouping pilots

# Verify superset property: all tasks in 50 should be in 150
missing_from_150 = set(subset_50) - set(subset_150)
if missing_from_150:
    print(f"ERROR: {len(missing_from_150)} tasks in 50 not in 150. Breaking superset property!")
else:
    print(f"✓ Superset property verified: all 50 tasks are in the 150 subset")

# Write subset files
subset_50_path = Path.cwd() / "subset-50.txt"
subset_150_path = Path.cwd() / "subset-150.txt"

subset_50_path.write_text("\n".join(subset_50) + "\n")
subset_150_path.write_text("\n".join(subset_150) + "\n")

print(f"\nWrote {len(subset_50)} tasks to {subset_50_path}")
print(f"Wrote {len(subset_150)} tasks to {subset_150_path}")
print(f"\nSelection method: RANDOM (uniform sampling from pool)")
print(f"Random seed: {SEED}")
print(f"Superset property: 11 pilot ⊂ 50 ⊂ 150 ⊂ 731")
print(f"  (subset-50 = first 50 tasks from shuffled subset-150)")
