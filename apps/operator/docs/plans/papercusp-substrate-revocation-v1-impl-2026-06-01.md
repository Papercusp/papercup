---
title: Substrate revocation v1 — implementation plan
slug: papercusp-substrate-revocation-v1-impl-2026-06-01
status: draft
created: 2026-06-01
owner: avi@storewolf.com
implements_spec: papercusp-substrate-revocation-v1-2026-06-01
---

# Substrate Revocation v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Model B admission gate ENFORCE published `revoked_pubkeys` (currently ignored — a latent gap), and add a self-revocation trigger.

**Architecture:** boot seeds its `revoked` Set from the union of all contributors' `revoked_pubkeys` (existing `harness_shared.contributors` column) at startup + refreshes after each merge; a `revokeSelfDevice` core (endpoint + MCP tool) appends the local peer's updated contributor row + calls the live `handle.revoke()`. Self-revocation only (authority-free); owner-revokes-others is out of scope (v2).

**Tech Stack:** TypeScript, Vitest 4, Postgres (`harness_shared.contributors`), the Model B substrate (`apps/operator/lib/sync/hyperbee/*`).

**Spec:** `apps/operator/docs/plans/papercusp-substrate-revocation-v1-2026-06-01.md` (D-001..D-005). Read it first.

---

## Now

**State:** DRAFT plan ready for subagent-driven execution. 3 tasks in dependency order. Repo discipline: `main` directly, no branches/PRs/push; commit each task `git add <paths>` + `git commit --no-verify` + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `:3070` has no hot-reload (`systemctl --user restart papercup-dev-api.service`). Tests: `cd apps/operator && npx vitest run <path>`.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/operator/lib/sync/hyperbee/load-revoked-pubkeys.ts` | create | Read the union of `revoked_pubkeys` across `harness_shared.contributors` for a harness. |
| `apps/operator/lib/sync/hyperbee/boot.ts` | modify | Seed `revoked` from the loader at startup; refresh + drop after each merge. |
| `apps/operator/lib/sync/hyperbee/revoke-self-device.ts` | create | Core: append updated own contributor row (pubkey → `revoked_pubkeys`) + call live `handle.revoke()`; guard "must be your own key". |
| `apps/operator/lib/endpoint-route/routes/admin/substrate-revoke-self-device.ts` | create | `POST /api/admin/substrate/revoke-self-device` (loopback/Host-gated, deps-injected). |
| `apps/operator/lib/agent-tools/<group>/revoke-self-device.ts` (+ index import) | create | `substrate:revoke_self_device` MCP tool wrapping the core, with `guidance.when`. |

---

### Task 1: `loadRevokedPubkeys` (enforcement read)  [D-001, D-002]

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/load-revoked-pubkeys.ts`
- Test: `apps/operator/lib/sync/hyperbee/__tests__/load-revoked-pubkeys.test.ts`

- [ ] **Step 1: Write the failing test** (union + dedupe across rows; empty harness → empty; injected query):

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadRevokedPubkeys } from '../load-revoked-pubkeys';

describe('loadRevokedPubkeys', () => {
  it('unions + dedupes revoked_pubkeys across contributor rows', async () => {
    const runQuery = vi.fn(async () => [
      { revoked_pubkeys: ['PUB_A', 'PUB_B'] },
      { revoked_pubkeys: ['PUB_B', 'PUB_C'] },
      { revoked_pubkeys: [] },
    ]);
    const set = await loadRevokedPubkeys({ workspaceId: 'w', harnessSlug: 's', runQuery });
    expect([...set].sort()).toEqual(['PUB_A', 'PUB_B', 'PUB_C']);
    // query is scoped to the (workspace, harness)
    expect(runQuery).toHaveBeenCalledOnce();
  });
  it('empty harness → empty set', async () => {
    const set = await loadRevokedPubkeys({ workspaceId: 'w', harnessSlug: 's', runQuery: async () => [] });
    expect(set.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/operator && npx vitest run lib/sync/hyperbee/__tests__/load-revoked-pubkeys.test.ts`
- [ ] **Step 3: Implement.** Default `runQuery` uses the org PG (`getOrgPg().sql.unsafe`) like `dogfood-substrate-health.ts`'s `runQuery`. Query: `SELECT revoked_pubkeys FROM harness_shared.contributors WHERE workspace_id = $1 AND harness_slug = $2`. Flatten + dedupe into a `Set<string>`. Confirm the exact table/columns against `apps/operator/lib/sync/hyperbee/projections/contributors.ts` (table name + that `revoked_pubkeys` is `TEXT[]`). Returns `Promise<Set<string>>`. Injectable `runQuery` seam.

```ts
import { getOrgPg } from '@/lib/org-pg'; // confirm the real import used elsewhere in this dir
export interface LoadRevokedOpts {
  workspaceId: string; harnessSlug: string;
  runQuery?: (q: string, params: unknown[]) => Promise<Array<{ revoked_pubkeys: string[] }>>;
}
export async function loadRevokedPubkeys(opts: LoadRevokedOpts): Promise<Set<string>> {
  const runQuery = opts.runQuery ?? (async (q, p) => {
    const { sql } = getOrgPg();
    return (await sql.unsafe(q, p as never)) as unknown as Array<{ revoked_pubkeys: string[] }>;
  });
  const rows = await runQuery(
    'SELECT revoked_pubkeys FROM harness_shared.contributors WHERE workspace_id = $1 AND harness_slug = $2',
    [opts.workspaceId, opts.harnessSlug],
  );
  const set = new Set<string>();
  for (const r of rows) for (const k of r.revoked_pubkeys ?? []) set.add(k);
  return set;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(substrate): loadRevokedPubkeys — read published revocations (D-001)`.

---

### Task 2: boot enforces published revocations (startup + merge refresh)  [D-002]

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/boot.ts`
- Test: `apps/operator/lib/sync/hyperbee/__tests__/revocation-enforcement.test.ts` (new) or extend `boot.test.ts`

- [ ] **Step 1: Write failing tests** (inject a `loadRevokedOverride`):
  - startup: boot with `loadRevokedOverride: async () => new Set(['PUB_X'])` → an announce from a peer whose `device_pubkey === 'PUB_X'` is refused (`onAnnounce` decision reason `'revoked'`); the peer's log is NOT admitted — on the FIRST announce (proves startup seeding).
  - merge refresh: boot with an override whose returned set GROWS between calls (return `new Set()` first, then `new Set(['PUB_Y'])`); admit `PUB_Y` first (it's not yet revoked), then after a merge tick that re-loads, `PUB_Y` is dropped from `admitted` + a `peer_revoked` event recorded.

```ts
it('refuses an announce from a startup-revoked pubkey on first contact', async () => {
  const handle = await bootHarnessSubstrate({
    /* test seams */ loadRevokedOverride: async () => new Set(['PUB_X']),
    verifyBindingOverride: async () => 'verified', mergePollMs: 0, pendingRetryMs: 0,
  });
  const decision = await handle.onAnnounce(announceFrameFor('PUB_X'));
  expect(decision.admit).toBe(false);
  expect(decision.reason).toBe('revoked');
  expect(handle.admitted.has(logKeyFor('PUB_X'))).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add `opts.loadRevokedOverride?: () => Promise<Set<string>>` (default `() => loadRevokedPubkeys({ workspaceId, harnessSlug })`). After `const revoked = new Set<string>()` (boot.ts ~401): `try { for (const k of await loadRevoked()) revoked.add(k); } catch (e) { recordBootEvent(...,'merge_error', ...); /* fail-open on load */ }`. In the merge driver (the `mergeNow`/poll path), after a successful merge, re-run `loadRevoked()` and for each NEW pubkey not already in `revoked`: add it, and if it maps to an `admitted` log (via `pubkeyToLogKey`), run the existing drop path (remove from `admitted`, record `peer_revoked`, re-merge). Keep it bounded/defensive (a load failure on refresh logs + continues). Do NOT block boot on the load.
- [ ] **Step 4: Run — expect PASS;** then full hyperbee suite green (`npx vitest run lib/sync/hyperbee/`).
- [ ] **Step 5: Commit** — `feat(substrate): boot enforces published revoked_pubkeys + merge refresh (D-002)`.

---

### Task 3: `revokeSelfDevice` core + endpoint + MCP tool  [D-003, D-004, D-005]

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/revoke-self-device.ts`
- Create: `apps/operator/lib/endpoint-route/routes/admin/substrate-revoke-self-device.ts`
- Create: `apps/operator/lib/agent-tools/<group>/revoke-self-device.ts` (+ `import './<group>/revoke-self-device';` in `apps/operator/lib/agent-tools/index.ts`)
- Tests: colocated `__tests__` for the core + the route.

- [ ] **Step 1: Write failing tests** for `revokeSelfDevice`:
  - success: given the local identity owns `PUB_OWN`, calling with `devicePubkey: 'PUB_OWN'` → appends an updated contributor row (spy on the injected `writeContributorRow`) with `PUB_OWN` in `revoked_pubkeys` (idempotent — already-present is fine), AND calls the injected live `handle.revoke('PUB_OWN')`.
  - refusal: `devicePubkey` NOT among the local identity's own keys → returns/throws a structured `not_your_key` error; does NOT write or revoke.
  - not booted: no live handle → still writes the row (persisted for next boot) but reports `handle_not_booted` (the row write is the durable part).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `revokeSelfDevice({ workspaceId, harnessSlug, devicePubkey, ...seams })`.** Seams: `resolveIdentity` (default `resolveLocalGithubIdentity`), `loadOwnRow` (default: select the local identity's contributor row from `harness_shared.contributors` by `github_user_id`), `writeRow` (default the real `write-contributor-row` append to the booted handle's own log), `getHandle` (default `listBootedHandles`/the boot map lookup for `(workspaceId, harnessSlug)`). Logic:
  1. resolve identity → `gh_auth_required` error if not authed.
  2. load own row; the set of own device pubkeys = the row's `device_attestations[].device_pubkey` (+ the row's primary `device_pubkey` if modeled). If `devicePubkey` ∉ own keys → `{ ok:false, code:'not_your_key' }`.
  3. compute `revoked_pubkeys' = unique([...row.revoked_pubkeys, devicePubkey])`; if unchanged → idempotent success (still call handle.revoke for live effect).
  4. `await writeRow(updatedRow)` (append to own log → replicates + projects).
  5. if a live handle exists → `await handle.revoke(devicePubkey)`; else note `handle_not_booted`.
  Return `{ ok:true, revoked: devicePubkey, live: <bool> }`. Idempotent.
- [ ] **Step 4: Endpoint** `substrate-revoke-self-device.ts`: `defineTool({ method:'POST', path:'/admin/substrate/revoke-self-device', auth:'public' })` BUT loopback/Host-gated (mirror the gate the other `/admin/*` substrate routes use — confirm the existing pattern, e.g. the D-009 loopback/Host gate). Extract `handleRevokeSelfDevice(input, deps)` (deps-injected like `share-finalize`/`join-link`). Body `{ workspaceId, harnessSlug, devicePubkey }` → `revokeSelfDevice`. Map: success→200; `not_your_key`→403; bad input→400; `gh_auth_required`→401. Test the handler with injected deps.
- [ ] **Step 5: MCP tool** `revoke_self_device.ts` (`defineTool` with `guidance: { when: 'Revoke ONE of your OWN device keys from a harness (lost/rotated device). Self-revocation only — cannot revoke another contributor.', notWhen: 'kicking out another contributor (not supported in v1)', chaining: '...' }`); add the index import; if exposed on a chat surface add to its `allowedTools` (operator-mcp-tools). Run the tools-md-sync test (`npx vitest run tools-md-sync`).
- [ ] **Step 6: Run** all: `cd apps/operator && npx vitest run lib/sync/hyperbee/ lib/endpoint-route/routes/admin/ lib/__tests__/tools-md-sync` — green.
- [ ] **Step 7: Commit** — `feat(substrate): revokeSelfDevice core + admin endpoint + MCP tool (D-003/D-004)`.

---

## Verification (whole-plan)
1. All task tests green; full hyperbee + admin-route suites green; `tools-md-sync` green.
2. The boot integration test proves a published revocation is enforced at startup AND via merge refresh.
3. `revokeSelfDevice` refuses a non-own key (owner-revocation stays out of scope).
4. (Manual, optional) restart `:3070`; `POST /api/admin/substrate/revoke-self-device` for an own device → PG row shows the pubkey in `revoked_pubkeys`.

## Out of scope (v2 — needs the owner's trust-model decision)
Owner-revokes-others (kicking a bad actor); un-revoke; a revocation UI. Recorded in the spec.
