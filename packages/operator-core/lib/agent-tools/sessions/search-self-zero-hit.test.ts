/**
 * search-self-zero-hit.test.ts — EI-18862790811651475.
 *
 * A 0-hit `sessions:search { session:'self' }` is CONFIDENCE-BUILDING: it reads
 * as "I checked and there is nothing" rather than "the query missed". When the
 * owner-scope (WI-5644/5681) actually spans MORE than the one resolved
 * transcript — this owner has other indexed session history in scope — the
 * tool must say so inline (`zeroHitCaveat`) instead of returning a bare 0.
 *
 * Run: cd packages/operator-core && npx vitest run \
 *   lib/agent-tools/sessions/search-self-zero-hit.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
}));

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...a: unknown[]) => resolveSelfSession(...a),
}));

// session:'self' also force-tails the live transcript; stub it out so the test
// never touches a real DB handle via the fail-soft ingest path.
vi.mock('../../search/session-ingest', () => ({
  ingestFileNow: vi.fn(async () => undefined),
}));

const tool = (await import('./search')).default;

interface ParsedResult {
  ok: boolean;
  total_hits: number;
  zeroHitCaveat?: string;
  self_session?: { source_kind: string; session_id: string };
}

/** Sequential stand-in for ctx.tx — each tagged-template call returns the next queued result set. */
function makeTx(results: unknown[][]) {
  let i = 0;
  const tx = vi.fn(async () => {
    const r = results[i] ?? [];
    i += 1;
    return r;
  });
  return { tx, calledTimes: () => tx.mock.calls.length };
}

function callTool(args: Record<string, unknown>, tx: unknown) {
  return (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx });
}

async function run(args: Record<string, unknown>, results: unknown[][]) {
  const { tx, calledTimes } = makeTx(results);
  const res = await callTool(args, tx);
  return { parsed: JSON.parse(res.content[0].text) as ParsedResult, txCalls: calledTimes() };
}

describe('sessions:search — session:self zero-hit caveat (EI-18862790811651475)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a zeroHitCaveat when the owner has OTHER indexed sessions in scope', async () => {
    resolveSelfSession.mockResolvedValue({
      sourceKind: 'claude',
      sessionId: 'sess-current',
      filePath: '/home/x/.papercusp/session-claude/su-self/projects/repo/sess-current.jsonl',
    });
    const { parsed, txCalls } = await run(
      { session: 'self', mode: 'verbatim', query: 'something I said yesterday' },
      [
        [], // main verbatim ILIKE query -> zero rows
        [{ session_count: '3', earliest: '2026-07-01T00:00:00.000Z' }], // owner-scope aggregate
      ],
    );

    expect(txCalls).toBe(2);
    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeDefined();
    expect(parsed.zeroHitCaveat).toMatch(/3/);
    expect(parsed.zeroHitCaveat).toMatch(/QUERY-MATCH MISS/);
  });

  it('omits the caveat when this IS the owner\'s only indexed session (a genuine 0)', async () => {
    resolveSelfSession.mockResolvedValue({
      sourceKind: 'claude',
      sessionId: 'sess-current',
      filePath: '/home/x/.papercusp/session-claude/su-self/projects/repo/sess-current.jsonl',
    });
    const { parsed, txCalls } = await run(
      { session: 'self', mode: 'verbatim', query: 'something never said' },
      [
        [], // main verbatim ILIKE query -> zero rows
        [{ session_count: '1', earliest: '2026-08-01T00:00:00.000Z' }], // only this session
      ],
    );

    expect(txCalls).toBe(2);
    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });

  it('never runs the extra aggregate query when there ARE hits', async () => {
    resolveSelfSession.mockResolvedValue({
      sourceKind: 'claude',
      sessionId: 'sess-current',
      filePath: '/home/x/.papercusp/session-claude/su-self/projects/repo/sess-current.jsonl',
    });
    const { parsed, txCalls } = await run(
      { session: 'self', mode: 'verbatim', query: 'a phrase that matches', context: 0 },
      [
        [{
          source_kind: 'claude', session_id: 'sess-current', turn_idx: 3, speaker: 'assistant',
          owner: 'su-self', harness_slug: null, ts: '2026-08-01T00:00:00.000Z', text: 'a phrase that matches',
        }],
      ],
    );

    expect(txCalls).toBe(1); // main query only — no aggregate probe (context:0 skips window hydration too)
    expect(parsed.total_hits).toBe(1);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });

  it('never runs the extra aggregate query for a non-self session (explicit id)', async () => {
    const { parsed, txCalls } = await run(
      { session: 'sess-explicit', mode: 'verbatim', query: 'anything' },
      [[]],
    );

    expect(resolveSelfSession).not.toHaveBeenCalled();
    expect(txCalls).toBe(1);
    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });
});
