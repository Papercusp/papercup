---
rel_path: "e2e/perf-load-sensitivity-2026-06-11.md"
updated_at: 1781166429959
_body: "content"
---

# P-013 load-sensitivity characterization — staging :3170 — 2026-06-11 ~07:00–08:30Z — su-6c28e
Plan: app-impersonation-e2e-round2-2026-06-10 P-013. Method: background sampler (120s cadence, 5 samples/endpoint/tick, curl TTFB `time_starttransfer`), loadavg captured per tick, bucketed quiet (<12) / medium (12–24) / heavy (>24). Observed load1 range 9.45–48.61 over ~90 min of organic fleet churn (n=42–43 ticks/endpoint). Raw TSV: /tmp/e2e-r3-p013.tsv (sampler /tmp/e2e-r3-p013-sampler.sh).

## Results (TTFB ms)

| endpoint | bucket | n | med-of-meds | p90 of meds | worst max | errs |
|---|---|---|---|---|---|---|
| /healthz | quiet (<12) | 8 | 1.9 | 2.7 | 82.3 | 0 |
| /healthz | medium (12–24) | 24 | 1.8 | 7.7 | 175.3 | 0 |
| /healthz | heavy (>24) | 10 | 2.0 | 70.5 | 203.9 | 0 |
| /api/installed | quiet | 8 | 1.1 | 1.5 | 72.1 | 0 |
| /api/installed | medium | 24 | 1.2 | 4.4 | 82.3 | 0 |
| /api/installed | heavy | 10 | 1.3 | 3.8 | 124.3 | 0 |
| / | quiet | 9 | 1.9 | 7.9 | 42.9 | 1 |
| / | medium | 24 | 1.8 | 2.7 | 213.9 | 0 |
| / | heavy | 10 | 2.0 | 13.7 | 264.3 | 0 |

## Verdict — how to read future WARN/FAIL grades on this box

1. **Medians are load-INSENSITIVE.** med-of-meds moves ≤0.2ms from quiet to heavy (loadavg 48!). The 5-sample median used by the run-1/run-2 batteries is a robust statistic here — a median-based WARN/FAIL is trustworthy at any observed load. No loadavg gate needed for median grading.
2. **Tails are load-DOMINATED.** p90 of tick-medians degrades up to ~25× quiet→heavy (healthz 2.7→70.5ms); single-sample worst-cases reach 200–260ms on 1–2ms endpoints. Any future metric graded on p90/p95/max (or any single-sample probe) MUST either bucket by loadavg or be re-sampled in a quiet window before a FAIL is called.
3. **Practical rule for graders:** record loadavg per sample (the batteries already do); if a metric's median is within baseline, ignore tail excursions when load1 > ~24; if a FAIL rests on samples taken at load1 > 24, rerun in a quieter window before filing.
4. Errors: 1 of 645 fetches (transient on `/`, quiet window — consistent with a staging restart blip, not load).

