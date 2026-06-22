/**
 * cross-hive-boundary-tools.integration.test.ts — the MEDIATED Hive→Hive boundary,
 * driven through the REAL front-door TOOLS against REAL Postgres
 * (cross-hive-boundary-2026-06-08; hive-network-surface-2026-06-11 P-003/P-004 B-04/B-05;
 * shared-hive-public-release-2026-06-22 Lane T4).
 *
 * ## What was UNTESTED before this file
 * The grant policy and the send tools were each covered, but never TOGETHER on a real
 * stack:
 *   · `cross-hive-grants.integration.test.ts` exercises the grant STORE + admission
 *     FUNCTIONS (setCrossHiveGrant / assertOutboundGrant) directly — not through a tool.
 *   · `cross-hive-ask-tools.test.ts` exercises the `hive:ask` / `hive:request_work` TOOLS,
 *     but SHORT-CIRCUITS the grant gate with an always-allow `checkOutboundGrant` fake —
 *     so the real grant store gating the tools is never proven.
 *
 * This file closes that seam: it drives the ACTUAL `hive:cross_grant`, `hive:ask`,
 * `hive:request_work`, and `hive:asks` tool handlers, with the REAL grants store + REAL
 * C-1 ask ledger on a fresh migrated Postgres (`getOrgPg` mocked to the fixture's admin
 * client — the blessed pattern from `harness-prompt-overrides.integration.test.ts`). The
 * ONLY substituted seam is the swarm transport boundary — registered as a fake in the
 * real boundary registry (a Hive needs a live boundary, which has no swarm here) — exactly
 * what every other cross-Hive test fakes (the in-memory `Bus` in `cross-hive-e2e.test.ts`).
 *
 * Proves the owner's directed cross-Hive grant actually mediates the boundary, end-to-end,
 * through the tools:
 *   1. default-deny: an UN-granted `hive:ask` is rejected (no send, no ledger row);
 *   2. owner grants `out` ask via `hive:cross_grant` → the SAME `hive:ask` is admitted,
 *      delivered, and the peer's answer lands `answered` in the C-1 ledger (admitted+answered);
 *   3. `hive:cross_grant` revoke → the ask is rejected again;
 *   4. `hive:request_work` crosses ONLY with an outbound `work-request` grant (an `ask`-only
 *      grant denies it; granting `work-request` admits it);
 *   5. the P-013 grant quota (size cap) gates an oversize `hive:ask` body through the tool.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/cross-hive-boundary-tools.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { CrossHiveBoundaryWiring } from '../../cross-hive-wiring';
import type { SendResult } from '../../cross-hive-transport';

// Redirect EVERY store that routes through getOrgPg().sql (hive_settings, the cross-Hive
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
const { insertHiveIfAbsent } = await import('../../hive-store');
const { PgCrossHiveAsks } = await import('../../cross-hive-asks-pg');
const {
  registerCrossHiveBoundary,
  __clearCrossHiveBoundaryRegistry,
} = await import('../../cross-hive-boundary-registry');
const { __setCrossHiveAskTestDeps } = await import('./_cross-hive-ask-deps');

// The four tool handlers under test (resolved after the mock so their import graph picks
// up the mocked getOrgPg).
const crossGrantTool = (await import('./cross_grant')).default as unknown as Tool;
const askTool = (await import('./ask')).default as unknown as Tool;
const requestWorkTool = (await import('./request_work')).default as unknown as Tool;
const asksTool = (await import('./asks')).default as unknown as Tool;

const WS = 'default';
const HIVE = 'my-hive'; // THIS Hive's home slug (the asking side)
const PEER = 'peer-hive-B-directory-pubkey';
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
    selfHivePubkey: 'self-pub',
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
  parse(await crossGrantTool.handler({ hive: HIVE, workspace: WS, ...extra }, ROOT_CTX));
const ask = async (extra: Record<string, unknown> = {}) =>
  parse(await askTool.handler({ hive: HIVE, workspace: WS, peerHivePubkey: PEER, subject: 's', body: 'b', ...extra }, ROOT_CTX));
const requestWork = async (extra: Record<string, unknown> = {}) =>
  parse(await requestWorkTool.handler({ hive: HIVE, workspace: WS, peerHivePubkey: PEER, subject: 's', body: 'b', ...extra }, ROOT_CTX));
const listAsks = async (extra: Record<string, unknown> = {}) =>
  parse(await asksTool.handler({ hive: HIVE, workspace: WS, ...extra }, ROOT_CTX));

let db: OrgTestDb;
let boundary: ReturnType<typeof fakeBoundary>;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // A Hive identity must exist for hive_settings (and thus grants) to attach to.
  await insertHiveIfAbsent(
    { workspaceId: WS, homeSlug: HIVE, pubkeyBase64: Buffer.alloc(32).toString('base64'), keychainId: 'kc-1' },
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
  __clearCrossHiveBoundaryRegistry();
  boundary = fakeBoundary(true);
  registerCrossHiveBoundary(WS, HIVE, boundary.wiring);
});

afterEach(() => {
  __setCrossHiveAskTestDeps(null); // ensure the REAL deps (PG store + real grant gate) — hygiene
  __clearCrossHiveBoundaryRegistry();
});

describe('cross-Hive boundary, mediated through the real tools (grant → ask/answer + request_work)', () => {
  it('default-deny: an UN-granted hive:ask is rejected — no send, no ledger row', async () => {
    const res = await ask();
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/no outbound grant/i);
    // The grant gate ran BEFORE any side effect: the transport was never touched...
    expect(boundary.sends).toHaveLength(0);
    // ...and no C-1 row was recorded.
    const all = await listAsks();
    expect(all.count).toBe(0);
  });

  it('owner grants `out` ask via hive:cross_grant → hive:ask is admitted, delivered, and answered (C-1)', async () => {
    // STEP 1 — the owner directs an OUTBOUND ask grant to the peer through the tool.
    const g = await grant({ action: 'grant', direction: 'out', peerHivePubkey: PEER, kinds: ['ask'] });
    expect(g.ok).toBe(true);

    // STEP 2 — the SAME hive:ask now passes the real outbound gate, delivers, records `sent`.
    const res = await ask({ subject: 'review auth schema', body: 'please advise' });
    expect(res.ok).toBe(true);
    expect(res.state).toBe('sent');
    expect(res.delivered).toBe(true);
    const correlationId = res.correlationId as string;
    expect(res.answeredEvent).toBe(`cross-hive:answered:${correlationId}`);
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
    const reply = await new PgCrossHiveAsks(WS, HIVE, db.adminSql).recordReply({
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

  it('hive:cross_grant revoke → the once-admitted hive:ask is rejected again', async () => {
    // Grant, prove admission, then revoke through the tool.
    await grant({ action: 'grant', direction: 'out', peerHivePubkey: PEER, kinds: ['ask'] });
    expect((await ask()).ok).toBe(true);
    expect(boundary.sends).toHaveLength(1);

    const r = await grant({ action: 'revoke', direction: 'out', peerHivePubkey: PEER });
    expect(r.ok).toBe(true);

    const after = await ask();
    expect(after.ok).toBe(false);
    expect(String(after.reason)).toMatch(/no outbound grant/i);
    // No NEW send after the revoke (still just the one from the granted ask above).
    expect(boundary.sends).toHaveLength(1);
  });

  it('hive:request_work crosses ONLY with an outbound work-request grant', async () => {
    // An `ask`-only outbound grant does NOT authorize a work-request.
    await grant({ action: 'grant', direction: 'out', peerHivePubkey: PEER, kinds: ['ask'] });
    const denied = await requestWork();
    expect(denied.ok).toBe(false);
    expect(String(denied.reason)).toMatch(/work-request/i);
    expect(boundary.sends).toHaveLength(0);

    // Grant the work-request kind → the work-request crosses.
    await grant({ action: 'grant', direction: 'out', peerHivePubkey: PEER, kinds: ['ask', 'work-request'] });
    const ok = await requestWork({ subject: 'please migrate X', body: 'do the thing' });
    expect(ok.ok).toBe(true);
    expect(ok.delivered).toBe(true);
    expect(boundary.sends).toEqual([{ to: PEER, kind: 'work-request', id: ok.correlationId, subject: 'please migrate X', body: 'do the thing' }]);
    const sent = await listAsks({ kind: 'work-request', state: 'sent' });
    expect(sent.count).toBe(1);
  });

  it('the P-013 grant quota (size cap) gates an oversize hive:ask body through the tool', async () => {
    // Grant outbound `ask` with a tiny body-size cap (the tool persists maxBodyBytes on the grant).
    await grant({ action: 'grant', direction: 'out', peerHivePubkey: PEER, kinds: ['ask'], maxBodyBytes: 5 });

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
