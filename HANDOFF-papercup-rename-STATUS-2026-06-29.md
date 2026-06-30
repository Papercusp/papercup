# STATUS — papercup→papercusp rename & schema migration (Brief #5, 11 items)

> Author: su-1a5c2d41 (autonomous AUTO-mode loop, 2026-06-29, owner asleep).
> Companion to `HANDOFF-papercup-rename-window-runbook-2026-06-24.md` (still current).
> Plans: `papercup-physical-rename-phase5-2026-06-20`, `papercup-to-papercusp-migration-2026-06-20`,
> `deterministic-blueprints-migration-2026-06-13` (P-142), `universal-schema-2026-05-30` (P-007).

## TL;DR
The functional identity migration is effectively complete. Of the 11 brief items, the
code/data work that is safe to do autonomously is **done or verified-done**. What remains
is a small set of **genuinely owner-gated** actions that hit hard boundaries an autonomous
agent must not cross overnight (a DB **superuser** privilege I don't hold; a systemd
**dev-api restart that severs the operator/MCP**; a cross-boundary **re-architecture**; an
**external-repo Tier-1 run**). Each is listed below with the exact command.

---

## What I did this session (safe, reversible, landed)

### phase5 P-009 / migration P-005 (schema CONTRACT) — authored + applied + recorded
- Independently **re-verified the drop gate** against the live DB + all 3 running trees
  (dev `papercusp`, `papercup-staging`, `papercup-release`): `papercup_shared` = exactly 6
  compat **views** over `papercusp_shared` (6 real tables); **0** publications/slots/subscriptions,
  **0** live queries referencing it, **0** cross-schema deps, **0** runtime `.ts/.js` refs in any tree.
  Replication-safe exactly as the 06-24 runbook §0 found. Captured a **reversal script**
  (the 6 view DDLs) to scratchpad before touching anything.
- Wrote migration **`422-drop-papercup-shared-compat.sql`** (runbook's planned "394" slot was
  taken by `394-operator-quota-overrides.sql`; 421 was max on disk+recorded). Placed in BOTH
  `libs/papercusp/libs/db/sql/` and `papercusp-desktop/src-tauri/sidecar/db-sql/` (identical sha256).
- Made it **idempotent + privilege-graceful**: it DROPs when the running role owns the schema
  or is superuser (so **fresh installs / re-provisions auto-contract** — there `harness_admin`
  owns `papercup_shared`), and **warn-and-no-ops** otherwise so it can never wedge the
  boot-migrator. Applied + recorded in `harness_shared.schema_migrations` (exit 0, no wedge).

  ⚠️ **One residual needs YOU (1 command):** on THIS live shared dev DB, `papercup_shared` is
  owned by the **superuser `postgres_app`** (artifact of the original manual EXPAND apply),
  and the operator runs as non-superuser `harness_admin` — so neither I nor the runner can
  drop it. The 6 views are harmless dead weight until then. Drop once as a superuser:
  ```bash
  psql "postgresql://postgres_app:<pwd>@localhost:5432/papercusp" -c "DROP SCHEMA papercup_shared CASCADE;"
  ```
  Reversal if ever needed (data is untouched in `papercusp_shared`):
  `CREATE SCHEMA papercup_shared; CREATE OR REPLACE VIEW papercup_shared.<t> AS SELECT * FROM papercusp_shared.<t>;`
  for t in (briefings, directive_summaries, directives, message_comments, message_recipients, messages).

### migration P-004 (cutover code) — VERIFIED DONE
`register-papercusp.ts` exists; **0** live refs to `register-papercup` / `PAPERCUP_HARNESS_SLUG` /
`PAPERCUP_ROOT`; `LEGACY_DEFAULT_HOME_HARNESS = 'papercusp'`; `operator-home-harness.test.ts`
expects `'papercusp'`. → mark **done**.

### migration P-001 (seed-learning install_slug literals) — VERIFIED OBSOLETE
The two resolver sites already use `operatorHomeHarnessSlug()` (`learning-loops.ts`,
`learning-loop-health.ts`). The remaining `install_slug='papercup'` literals in
`seed-learning-singletons.ts` are **intentional legacy-RETIREMENT queries** (they target the
old papercup rows to delete them; line 249 comment confirms). Swapping them to the resolver
would break retirement. → mark **dropped/obsolete** (matches the plan's `## Now`).

### phase5 P-001 / P-007 (repo dir rename) — DONE via symlink bridge (already in place)
`papercupai-workspace/papercup` is now a **symlink → papercusp**; real dir is `papercusp`;
hive registry `path` already `…/papercusp`. Non-breaking. Residual = remove the symlink, which
is coupled to the systemd rename (P-008) — keep it until 0 refs to the old path remain.

### phase5 P-006 (monorepo rename + grep gate) — rename DONE; grep-zero gate BLOCKED
`package.json` name is already `@papercupai/papercusp-monorepo`. The grep-zero gate can't reach
zero yet — residuals are (a) the retained `papercup→papercusp` **symlink** (double-counts files;
gated on P-008) and (b) the **`papercupai.com` public site + `@papercupai` npm scope** (domain
config in `docker-compose.papercup.prod.yml`, `PAPERCUP_DOMAIN`, ~205 plugin-manifest/identity
files) which the 06-24 runbook §4 explicitly scopes OUT as a separate deliberate owner decision.

---

## What remains — OWNER-GATED (hard boundaries; NOT auto-executed)

1. **Live-DB CONTRACT drop** (above) — needs the `postgres_app`/`postgres` **superuser** password,
   which is not in the repo. 1 command.
2. **phase5 P-008 systemd service rename** `papercup-*` → `papercusp-*` (11 units). Sequencing puts
   **`papercup-dev-api` LAST because its restart bounces :3070 / the operator MCP** — i.e. it would
   sever this very session mid-window with no way to verify/rollback while you sleep, and it needs a
   quiescent window (the fleet is live). This is the canonical AUTO-mode stop. Full per-unit runbook:
   `HANDOFF-papercup-rename-window-runbook-2026-06-24.md` §2 Step C. (Pure cosmetics; everything
   functional already homes on papercusp.) Then drop the dir symlink (Step B tail) once 0 refs remain.
3. **deterministic-blueprints-migration P-142** — stages (b)-(e) are an operator↔subprocess
   durability **re-architecture** (per-chunk DBOS-step program), explicitly owner-gated for a staged
   dark-launch + production monitoring. Stage (a) (`runChunkLoopCore` extraction) is already done.
4. **universal-schema P-007** — Tier-2 per-type synthesis mints automatically once the **owner boots
   `restart` on the external Restart repo and runs Tier-1**; also blocked by its P-006. Not autonomous-safe.
5. **`@papercupai` npm scope / `papercupai.com`** — deliberate brand decision, out of the rename's
   mechanical scope (runbook §4). Needed for a literal grep-zero, but is your call.

---

## Plan-status writes still pending (papercusp-su MCP was disconnected during this session)
When the MCP is back these get pushed (tracked so they aren't lost):
- phase5 `P-001` → **done** (dir renamed via symlink bridge).
- phase5 `P-009` → **done** (migration authored/applied/recorded; live-DB superuser drop escalated as the lone residual).
- migration `P-004` → **done** (verified).
- migration `P-001` → **dropped** (obsolete; intentional retirement literals).
- phase5 `P-006` → note: monorepo rename done; grep-zero gate blocked on P-008 + `@papercupai` decision.
- migration `P-005` / `P-006`, phase5 `P-007`/`P-008`, P-142, universal P-007 → remain todo, owner-gated (this doc is the escalation).
