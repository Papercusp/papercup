# Evidence — plan portal-parity-adv-tabs-2026-09-05 (WI-1965083 unit 2, WI-2146625)

Durable copies of the verification evidence produced on 2026-09-05 against the cloud portal
release `osoChjb97qhK7F76n-BA9-20260905201607350` (served on the local loopback portal port 3081).

- `sweep-20260905T201656Z.txt` — P-006 verdict sweep: one `KIND=` line per new rail kind
  (15/15 `notInPortal:false`, own headings, `potBar` true on exactly the 9 pot-scoped kinds),
  six `RAIL` rows (P-007) and `SWEEP_END`.
- `sweep.sh` — the script that produced it (verdict goto/js/screenshot per kind).
- `rail-measurement-20260905T2033Z.json` — P-007 `.rail-apps` scroll-container measurement + DOM order.
- `coord-1280x800.png`, `rail-1280x800-coord.png` — screenshots of the Coordination surface and the rail
  scrolled to it.
- `parity-inventory.md` — the unit-2 inventory of desktop ADV tabs vs portal rail kinds that scoped the plan.
