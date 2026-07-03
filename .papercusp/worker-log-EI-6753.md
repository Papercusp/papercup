# Worker log — EI-6753

**Bug:** CHRONIC autoloop failure: `loop-su-30633068-a395-4c76-a1d7-7bc5c3c3095d@*` red (11→19) consecutive fires.

## Diagnosis (evidence-based)

- Recorded `last_status` **verbatim** = `loop-terminal-unreachable` (not the `loop-stuck-backstop` from the title — the failure mode advanced).
- The loop's routine `rt___loop_su_30633068_…` is already **`active=false`** — auto-terminated by the WI-1399 dead-owner terminal-unreachable guard in `reconcile-loop-routines.ts` (owner su-session `su-30633068…` died → the loop had no injectable/resumable wake channel). So the **root cause (a dead-owner loop firing red into the void) is already durably fixed** — the loop was auto-paused, not left firing.
- The chronic-failure sweep (`autoloop-chronic-failure.ts`) now correctly **skips** this row (`routine_active === false` → `skipped-paused`), so it will not re-escalate. Verified live: `SELECT … WHERE consecutive_errors>=6 AND routine_active IS DISTINCT FROM false AND last_fired_at > now()-6h` → **0 rows** (every red autoloop_state row is either paused or a stale/frozen watermark — both guards hold).

## The actionable code gap this bug revealed (the fix)

The bug body prescribes the remediation **"then `autoloop:control reset-errors`"** — but that command **could never reach the `harness_slug='*'` loop:arm rows** (`loop-su-*` / `loop-role-*`), which is exactly the class it escalates (`loop-su-<uuid>@*`):

- `loop:arm` loops record their fire-gate under `install_slug='*'` (`loop-fire.ts` `checkFireGate('*', role)` / `recordFire('*', …)`).
- `autoloop:control reset-errors` resets only the per-harness brain scopes `[workspaceId, slug]` (via `workspaceBrainReadKeys`), which **never include `'*'`**, and the tool refuses a literal `harness='*'`. So the prescribed remediation **silently no-op'd** for every `loop-su-*@*` row.

**Fix** (`packages/operator-core/lib/agent-tools/autoloop/control.ts`): extracted a pure `resetErrorScopes(brainScopes, role)` helper — when a **`role`** is given (always the loop:arm case) it also clears the `'*'` scope (deduped, order-stable); a **role-less** reset stays per-harness so it can't wipe every warm-session loop's counter across the workspace.

## Files changed
- `packages/operator-core/lib/agent-tools/autoloop/control.ts` — extract + use `resetErrorScopes`; role-scoped reset now reaches the `'*'` loop:arm scope.
- `packages/operator-core/lib/agent-tools/autoloop/control.test.ts` — **new** regression test (5 cases) for `resetErrorScopes` (role → includes `'*'`; role-less → excludes `'*'`; dedupe; order-stable). Fails pre-fix by construction (without the role-conditional `'*'`, the helper returns only the brain scopes).

## Verification
- `npx vitest run lib/agent-tools/autoloop/control.test.ts lib/harness/routines/autoloop-chronic-failure.test.ts` → **24 passed**.
- `npx vitest run --config vitest.integration.config.ts lib/agent-tools/autoloop/control.integration.test.ts` → **3 passed** (pause/resume unaffected).
- Typecheck (`tsc --noEmit`, filtered to the two changed files) → **0 errors** in-scope.

## Note for the validator / re-verify
- The specific `loop-su-30633068@*` `autoloop_state` row still shows `consecutive_errors=19` residue on a **dead (active=false)** routine. It is harmless — the sweep already ignores it (`skipped-paused`, verified) and it cannot re-escalate. Once this fix deploys, it is cleanable via `autoloop:control reset-errors { role: 'loop-su-30633068-…' }` (previously impossible). I did not hand-write the row via raw PG (dev:pg_query is read-only; no unattributed HTTP writes).
- STOP-gate check: the change is confined to the `autoloop:control` **agent tool** (counter-reset scope resolution). It does NOT touch the DBOS scheduler workflow, the fire path, migrations, auth, or the self-improvement loop's own code.
