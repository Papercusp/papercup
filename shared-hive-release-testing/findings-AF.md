# Findings — WAVE 5 Brief AF: Directory mechanics (+ the invite-beacon-capture bug)

Owner: su-ed300 (Brief L hive-directory/discovery context). This pass: fixed the concrete
beacon-capture bug dc9db found live, swept for siblings, and noted directory-mechanics
coverage.

---

## AF-1 — Invite/hive beacon capture crashes live (S2 observability) — ✅ FIXED

**Found by dc9db (live, integrated .deb):** `inst-b.log` repeatedly logs
`[hive-directory] beacon capture failed for spoon-knife-hive: The "string" argument must
be of type string ... Received an instance of Object`. The beacon-history capture is
best-effort (caught + warned at `hive-directory.ts:329`), so federation is unharmed — but
the **cross-hive beacon HISTORY (tier-4 dossier) is silently never written** on the live
binary. S2 (a feature silently doesn't work + a noisy log), not a blocker.

**Root cause:** `captureBeaconSnapshot` (`network-board/beacon-history-pg.ts`) bound the
**raw beacon OBJECT** as a parameter:
`pg(sql).unsafe('… VALUES ($1,$2,$3::jsonb)', [hiveId, hivePubkey, beacon])`. Per the
existing gotcha doc **`agent-insights/postgres-js-jsonb-binding`**, a bare object param (and
`sql.json(obj)`) **THROWS under the live `getOrgPg` postgres-js client** with exactly this
`ERR_INVALID_ARG_TYPE` at the Bind step. The **testcontainer client behaves OPPOSITELY**
(tolerates the object), so the existing integration test was GREEN while live threw — the
documented "passes-in-test, fails-live" jsonb class.

**Fix (canonical, insight-aligned):** bind as `${JSON.stringify(beacon)}::text::jsonb` in
the tagged-template form. The explicit `::text` forces a single text param parsed
server-side (text→jsonb) → a real jsonb **object** under BOTH clients (no live throw, no
testcontainer double-encode). Verified: `beacon-history-pg.integration.test.ts` **5/5 green**
(incl. `jsonb_typeof='object'` + value read-back); the insight independently verified
`::text::jsonb` against the live `:5432` host.

> ⚠ A near-miss worth recording: my first fix attempt used `sql.json(beacon)`, which PASSED
> the testcontainer (5/5) but — per the insight — would have **thrown live identically to the
> original bug**. The insight (found via a code-comment reference) corrected it. Lesson:
> `docs:search agent-insights/` BEFORE diagnosing a jsonb-binding failure.

## AF-2 — Sibling sweep: is this bug class elsewhere? — ✅ ISOLATED

Swept every `unsafe(... $N::jsonb ...)` insert in operator-core. **Every other jsonb insert
already `JSON.stringify(...)`s its param** (execute-action, harness-registry, flag-audit,
process-kill, slash/dispatch, turn/interrupt, _mcp-slash-prompts) — that's the
live-correct (`getOrgPg`) form. `beacon-history-pg.ts` was the lone deviation that bound a
**raw object**. No sibling live-throw bugs. (Note: the JSON.stringify-`::jsonb` siblings
would double-encode under a testcontainer pool — a test-fidelity caveat, not a live bug;
`::text::jsonb` is the strictly-better pattern for any future touch, per the insight.)

## AF-3 — Directory mechanics coverage

The core directory mechanics (discover accuracy, announce crossing, withdraw/unlist drop,
topic one-wayness, negative-isolation, the joiner-resolves-own-topic path) are **already
covered** by Brief L (G-001/G-002/G-003 + the live re-verify on the fix-`.deb`:
from-repo + invite reach=0 + withdrawn-drops-in-~3s) and the existing
`hive-directory*.test.ts` / `directory-swarm.test.ts` suites (151 green). No new directory
gap surfaced this pass beyond the beacon-capture bug.

---

## Verdict (dimension): 🟢 GREEN (the one live AF bug is fixed; mechanics covered)

The invite/hive beacon-capture crash — the concrete AF defect — is fixed (insight-aligned,
integration-verified) and isolated (no siblings). Directory mechanics are covered by Brief L
+ the existing suites. Open AF depth (announce-flood / churn-under-load directory behavior)
is unexercised but no known blocker.
