/**
 * cross-pot-boundary-tools.integration.test.ts — the MEDIATED Pot→Pot boundary,
 * driven through the REAL front-door TOOLS against REAL Postgres
 * (cross-hive-boundary-2026-06-08; hive-network-surface-2026-06-11 P-003/P-004 B-04/B-05;
 * shared-hive-public-release-2026-06-22 Lane T4).
 *
 * ## What was UNTESTED before this file
 * The grant policy and the send tools were each covered, but never TOGETHER on a real
 * stack:
 *   · `cross-pot-grants.integration.test.ts` exercises the grant STORE + admission
 *     FUNCTIONS (setCrossPotGrant / assertOutboundGrant) directly — not through a tool.
 *   · `cross-pot-ask-tools.test.ts` exercises the `pot:ask` / `pot:request_work` TOOLS,
 *     but SHORT-CIRCUITS the grant gate with an always-allow `checkOutboundGrant` fake —
 *     so the real grant store gating the tools is never proven.
 *
 * This file closes that seam: it drives the ACTUAL `pot:cross_grant`, `pot:ask`,
 * `pot:request_work`, and `pot:asks` tool handlers, with the REAL grants store + REAL
 * C-1 ask ledger on a fresh migrated Postgres (`getOrgPg` mocked to the fixture's admin
 * client — the blessed pattern from `harness-prompt-overrides.integration.test.ts`). The
 * ONLY substituted seam is the swarm transport boundary — registered as a fake in the
 * real boundary registry (a Pot needs a live boundary, which has no swarm here) — exactly
 * what every other cross-Pot test fakes (the in-memory `Bus` in `cross-pot-e2e.test.ts`).
 *
 * Proves the owner's directed cross-Pot grant actually mediates the boundary, end-to-end,
 * through the tools:
 *   1. default-deny: an UN-granted `pot:ask` is rejected (no send, no ledger row);
 *   2. owner grants `out` ask via `pot:cross_grant` → the SAME `pot:ask` is admitted,
 *      delivered, and the peer's answer lands `answered` in the C-1 ledger (admitted+answered);
 *   3. `pot:cross_grant` revoke → the ask is rejected again;
 *   4. `pot:request_work` crosses ONLY with an outbound `work-request` grant (an `ask`-only
 *      grant denies it; granting `work-request` admits it);
 *   5. the P-013 grant quota (size cap) gates an oversize `pot:ask` body through the tool.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pot/cross-pot-boundary-tools.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { CrossHiveBoundaryWiring } from '../../cross-hive-wiring';
import type { SendResult } from '../../cross-hive-transport';

// Redirect EVERY store that routes through getOrgPg().sql (hive_settings, the cross-Pot
// grants, the C-1 ask ledger) to the fixture's migrated admin client — so the tools, which
// pass sql=undefined internally, hit the test PG. PARTIAL mock: the import graph also pulls
// `generated` (lib/memory/backend-selection) from db-org, so spread the real module and
// override ONLY getOrgPg (the Drizzle build is lazy/on-call, so importing the real module
// is safe; only a CALL to getOrgPg()/getOrgPgApp() would build Drizzle).
const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { insertPotIfAbsent } = await import('../../pot-store');
const { PgCrossPotAsks } = await import('../../cross-pot-asks-pg');
const {
  registerCrossPotBoundary,
  __clearCrossPotBoundaryRegistry,
} = await import('../../cross-pot-boundary-registry');
const { __setCrossPotAskTestDeps } = await import('./_cross-pot-ask-deps');

// The four tool handlers under test (resolved after the mock so their import graph picks
// up the mocked getOrgPg).
const crossGrantTool = (await import('./cross_grant')).default as unknown as Tool;
const askTool = (await import('./ask')).default as unknown as Tool;
const requestWorkTool = (await import('./request_work')).default as unknown as Tool;
const asksTool = (await import('./asks')).default as unknown as Tool;

const WS = 'default';
const POT = 'my-pot'; // THIS Pot's home slug (the asking side)
const PEER = 'peer-pot-B-directory-pubkey';
const ROOT_CTX = { isSuperuser: true, uiClientId: 'su-test', workspaceId: WS } as never;

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text);

/** A fake boundary recording every send; `delivered` toggles the sent/queued path. The only
 *  substituted seam — there is no swarm transport in-process. */
function fakeBoundary(delivered = true): {
  wiring: CrossHiveBoundaryWiring;
  sends: Array<{ to: string; kind: string; id?: string; subject: string; body: string }>;
} {
  const sends: Array<{ to: string; kind: string; id?: string; subject: string; body: string }> = [];
  const wiring = {
    selfPotPubkey: 'self-pub',
    async send(to: string, msg: { kind: string; subject: string; body: string; id?: string }): Promise<SendResult> {
      sends.push({ to, kind: msg.kind, id: msg.id, subject: msg.subject, body: msg.body });
      return { delivered, queued: !delivered };
    },
    async reply() {
      return { delivered, queued: !delivered };
    },
    async flushOutbox() {
      return { delivered: 0, pending: 0 };
    },
    async close() {},
  } as unknown as CrossHiveBoundaryWiring;
  return { wiring, sends };
}

// ── Tool-call helpers (always pass `workspace` so the tools never touch activeWorkspaceId). ──
const grant = async (extra: Record<string, unknown>) =>
  parse(await crossGrantTool.handler({ pot: POT, workspace: WS, ...extra }, ROOT_CTX));
const ask = async (extra: Record<string, unknown> = {}) =>
  parse(await askTool.handler({ pot: POT, workspace: WS, peerPotPubkey: PEER, subject: 's', body: 'b', ...extra }, ROOT_CTX));
const requestWork = async (extra: Record<string, unknown> = {}) =>
  parse(await requestWorkTool.handler({ pot: POT, workspace: WS, peerPotPubkey: PEER, subject: 's', body: 'b', ...extra }, ROOT_CTX));
const listAsks = async (extra: Record<string, unknown> = {}) =>
  parse(await asksTool.handler({ pot: POT, workspace: WS, ...extra }, ROOT_CTX));

let db: OrgTestDb;
let boundary: ReturnType<typeof fakeBoundary>;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // A Pot identity must exist for hive_settings (and thus grants) to attach to.
  await insertPotIfAbsent(
    { workspaceId: WS, homeSlug: POT, pubkeyBase64: Buffer.alloc(32).toString('base64'), keychainId: 'kc-1' },
    db.adminSql,
  );
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // Reset the federated grant policy + the C-1 ledger between cases (the hives row persists).
  await db.adminSql`DELETE FROM harness_shared.hive_settings`;
  await db.adminSql`DELETE FROM harness_shared.cross_hive_asks`;
  __clearCrossPotBoundaryRegistry();
  boundary = fakeBoundary(true);
  registerCrossPotBoundary(WS, POT, boundary.wiring);
});

afterEach(() => {
  __setCrossPotAskTestDeps(null); // ensure the REAL deps (PG store + real grant gate) — hygiene
  __clearCrossPotBoundaryRegistry();
});

describe('cross-Pot boundary, mediated through the real tools (grant → ask/answer + request_work)', () => {
  it('default-deny: an UN-granted pot:ask is rejected — no send, no ledger row', async () => {
    const res = await ask();
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/no outbound grant/i);
    // The grant gate ran BEFORE any side effect: the transport was never touched...
    expect(boundary.sends).toHaveLength(0);
    // ...and no C-1 row was recorded.
    const all = await listAsks();
    expect(all.count).toBe(0);
  });

  it('owner grants `out` ask via pot:cross_grant → pot:ask is admitted, delivered, and answered (C-1)', async () => {
    // STEP 1 — the owner directs an OUTBOUND ask grant to the peer through the tool.
    const g = await grant({ action: 'grant', direction: 'out', peerPotPubkey: PEER, kinds: ['ask'] });
    expect(g.ok).toBe(true);

    // STEP 2 — the SAME pot:ask now passes the real outbound gate, delivers, records `sent`.
    const res = await ask({ subject: 'review auth schema', body: 'please advise' });
    expect(res.ok).toBe(true);
    expect(res.state).toBe('sent');
    expect(res.delivered).toBe(true);
    const correlationId = res.correlationId as string;
    expect(res.answeredEvent).toBe(`cross-pot:answered:${correlationId}`);
    // The fake boundary saw exactly the signed ask (envelope id === correlation id).
    expect(boundary.sends).toEqual([
      { to: PEER, kind: 'ask', id: correlationId, subject: 'review auth schema', body: 'please advise' },
    ]);
    // The C-1 ledger shows the row `sent`.
    const sent = await listAsks({ state: 'sent' });
    expect(sent.count).toBe(1);
    expect((sent.asks as Array<Record<string, unknown>>)[0]).toMatchObject({
      peerPubkey: PEER,
      kind: 'ask',
      direction: 'out',
      state: 'sent',
    });

    // STEP 3 — the peer's ANSWER comes back through the boot-wired boundary (simulated here
    // by the production reply-persistence path) and lands the row `answered` with the body.
    const reply = await new PgCrossPotAsks(WS, POT, db.adminSql).recordReply({
      correlationId,
      replyKind: 'answer',
      replyBody: 'reviewed — schema looks good',
    });
    expect(reply.outcome).toBe('applied');

    const answered = await listAsks({ state: 'answered' });
    expect(answered.count).toBe(1);
    expect((answered.asks as Array<Record<string, unknown>>)[0]).toMatchObject({
      correlationId,
      state: 'answered',
      replyBody: 'reviewed — schema looks good',
    });
  });

  it('pot:cross_grant revoke → the once-admitted pot:ask is rejected again', async () => {
    // Grant, prove admission, then revoke through the tool.
    await grant({ action: 'grant', direction: 'out', peerPotPubkey: PEER, kinds: ['ask'] });
    expect((await ask()).ok).toBe(true);
    expect(boundary.sends).toHaveLength(1);

    const r = await grant({ action: 'revoke', direction: 'out', peerPotPubkey: PEER });
    expect(r.ok).toBe(true);

    const after = await ask();
    expect(after.ok).toBe(false);
    expect(String(after.reason)).toMatch(/no outbound grant/i);
    // No NEW send after the revoke (still just the one from the granted ask above).
    expect(boundary.sends).toHaveLength(1);
  });

  it('pot:request_work crosses ONLY with an outbound work-request grant', async () => {
    // An `ask`-only outbound grant does NOT authorize a work-request.
    await grant({ action: 'grant', direction: 'out', peerPotPubkey: PEER, kinds: ['ask'] });
    const denied = await requestWork();
    expect(denied.ok).toBe(false);
    expect(String(denied.reason)).toMatch(/work-request/i);
    expect(boundary.sends).toHaveLength(0);

    // Grant the work-request kind → the work-request crosses.
    await grant({ action: 'grant', direction: 'out', peerPotPubkey: PEER, kinds: ['ask', 'work-request'] });
    const ok = await requestWork({ subject: 'please migrate X', body: 'do the thing' });
    expect(ok.ok).toBe(true);
    expect(ok.delivered).toBe(true);
    expect(boundary.sends).toEqual([{ to: PEER, kind: 'work-request', id: ok.correlationId, subject: 'please migrate X', body: 'do the thing' }]);
    const sent = await listAsks({ kind: 'work-request', state: 'sent' });
    expect(sent.count).toBe(1);
  });

  it('the P-013 grant quota (size cap) gates an oversize pot:ask body through the tool', async () => {
    // Grant outbound `ask` with a tiny body-size cap (the tool persists maxBodyBytes on the grant).
    await grant({ action: 'grant', direction: 'out', peerPotPubkey: PEER, kinds: ['ask'], maxBodyBytes: 5 });

    // A body over the cap is rejected pre-send by the real assertOutboundGrant size check.
    const over = await ask({ body: 'this body is far over five bytes' });
    expect(over.ok).toBe(false);
    expect(String(over.reason)).toMatch(/cap/i);
    expect(boundary.sends).toHaveLength(0);
    expect((await listAsks()).count).toBe(0);

    // A body within the cap still crosses (proves the cap gates on size, not a blanket deny).
    const under = await ask({ body: 'hi' });
    expect(under.ok).toBe(true);
    expect(boundary.sends).toHaveLength(1);
  });
});
