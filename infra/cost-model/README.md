# Estate cost model — GCP vs the Hetzner baseline

Plan `hetzner-to-gcp-restore-2026-08-28`, item **P-025**. Decisions **D-032** (model)
and **D-033** (Hetzner still billing).

Re-run the model — it re-measures everything, it does not read this file:

```bash
python3 infra/cost-model/estate-cost-model.py --daily-backup-gib 1.931
python3 infra/cost-model/estate-cost-model.py --json      # machine-readable
```

Every figure below was produced by that script on **2026-08-29T06:41Z**. Nothing here
is transcribed from a vendor price page or from memory; if a rate moves, re-running
changes the answer and this file is the thing that goes stale, not the model.

## Where the numbers come from

| input | authority |
|---|---|
| GCP unit prices | Cloud Billing Catalog API — the catalog the invoice is priced from |
| GCP inventory | `gcloud compute instances/disks/snapshots/addresses list` on the live project |
| Hetzner prices | `api.hetzner.cloud/v1/pricing` — the **account's own** currency and location rates |
| Hetzner traffic | `api.hetzner.cloud/v1/servers/{id}/metrics` — the provider's own accounting |
| Utilisation | `/proc/loadavg`, `/proc/stat`, `/proc/meminfo`, `df` on the live VMs |

## Verdict

**As built, GCP costs $496.35/mo against a like-for-like Hetzner baseline of
$282.98/mo — 1.75×. Right-sizing to measured utilisation plus a 1-year commitment
brings it to ~$219/mo, which is ~23% *below* the Hetzner baseline.** The gap is
entirely compute; every other line is rounding error.

| scenario | compute | total/mo |
|---|---|---|
| GCP as built (2× `n2d-custom-8-16384`, on-demand) | $427.69 | **$496.35** |
| GCP right-sized (prod 4/16, mesh 4/24), on-demand | $281.66 | ~$351 |
| GCP right-sized + 1-year CUD | $168.99 | **~$219** |
| GCP right-sized + 3-year CUD | $120.72 | ~$171 |
| Hetzner like-for-like (2× `cpx41`, US) | — | **$282.98** |
| Hetzner same spec in Germany (`fsn1`) | — | $75.98 |

Sustained-use discounts are **not** in the table. GCP applies them as a billing
credit, not a SKU, so the catalog cannot express them and the script does not
invent them — the on-demand rows are therefore an upper bound. The first full
month's invoice settles it.

## GCP monthly, as built

| line | $/mo | note |
|---|---|---|
| Compute — 2× `n2d-custom-8-16384` | 427.69 | 86% of the bill |
| `pd-balanced` 550 GiB (300 + 250) | 55.00 | |
| Snapshots, current generation 105.61 GiB | 6.86 | see caveat below |
| External IPv4 × 2 | 3.58 | tier structure unresolved; ≤ $7.30 |
| Egress, 14.4 GiB/mo measured | 1.61 | |
| GCS backups, 1.931 GiB/day measured | 1.60 | 14 d Standard → 31 d Nearline → delete |
| **Total** | **496.35** | |

**Snapshot caveat.** Only one generation exists, so $6.86 is a floor, not the steady
state. Retention is 14 daily generations and incrementals store only changed blocks;
the true figure is `6.86 + 13 × (daily delta GiB × 0.065)`, bounded above by $96.10 if
every generation were full. Probe once a second generation lands:
`gcloud compute snapshots list --format='table(name,storageBytes,creationTimestamp)'`.

**VM → bucket upload is free**, confirmed by SKU (`Network Data Transfer to Google
Services from Americas to Americas` = $0.00/GiB), not assumed.

## Right-sizing — measured, and asymmetric

Measured 2026-08-29 after ~10 h uptime, corroborated by 43 days of Hetzner production
on the identical 8-core spec (prod load average 0.16):

| | prod | mesh |
|---|---|---|
| CPU busy since boot | **4.41%** | **6.66%** |
| load average (1m) | 0.13 | 0.60 |
| memory available | 6.6 / 15.6 GiB | **1.2 / 15.6 GiB** |
| disk used | 112 / 290 GiB | 55 / 242 GiB |

The verdict is **not** "shrink everything". CPU is over-provisioned by roughly 15×;
**mesh memory is nearly exhausted** at 1.2 GiB available. Cutting vCPU while raising
mesh RAM is the correct move, and `n2d-custom` exists precisely to decouple the two.
Shrinking mesh RAM because "the VM is idle" would take down PostHog.

Recommended shapes: prod `n2d-custom-4-16384`, mesh `n2d-custom-4-24576`. Both stay
inside N2D's 0.5–8 GiB-per-vCPU envelope. This is a stop/resize/start, not a rebuild.

Disks are the weaker case: prod could go 300→200 GiB and mesh 250→120 GiB for ~$23/mo,
but **GCP persistent disks only grow**, so realising it means snapshot → create smaller
→ swap → verify. Worth doing alongside the resize, not on its own.

## Egress — D-010's premise corrected

Measured estate egress is **15.4 GB/month** (prod 14.7, mesh 0.7), across two
independent Hetzner metric windows that agree within 10% (Aug 1–18: 14.75 GB/30d;
Jul 30–Aug 1: 16.18 GB/30d). That is **$1.61/month** — 0.3% of the bill.

D-010 predicted egress would be "the estate's single largest egress exposure". Measured,
it is the second-smallest line. Three corrections, in D-032:

1. GCP bills **egress only**; ingress is $0.00/GiB by SKU. "Billable both ways" is wrong.
2. coturn and MediaMTX are containers on the **same VM**, so relayed media crosses the
   VM boundary exactly once — identical to the direct path. Opening 8189/udp (D-025)
   improved reachability and quality; it did not halve a doubled egress bill, because
   there was never a doubling to halve.
3. The estate's real traffic is small, so the whole line is ~$1.61.

**But the underlying worry was directionally right at scale, and this is the number to
carry forward.** Hetzner bundles 4 TiB with a `cpx41` and charges $1.20/TB beyond it;
GCP bills from the first GiB at $0.12. That is a ~100× per-GiB difference. Egress alone
equals one whole `cpx41` at **1.17 TiB/month — 83× current traffic**. In WebRTC terms a
1.5 Mbps stream is 0.629 GiB per participant-hour ($0.075), so break-even is roughly
**63 participant-hours per day**. Reachable for a video product. Egress is not a cost
today; it is the line that decides whether GCP stays cheaper if usage grows, and it is
the one to instrument before a launch.

## Why the Hetzner baseline was so high

Both `cpx41` instances sit in a **US** location at $141.49/mo against $37.99 for the
identical spec in `fsn1` — a **3.7× location premium**, measured from the account's own
price list. The migration was never competing with Hetzner's headline European pricing.
