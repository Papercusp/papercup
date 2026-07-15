/**
 * list.test.ts — EI-11403 regression.
 *
 * sessions:list { owner:'self' } returned count 0 for a LIVE Codex session that
 * sessions:search { session:'self' } and sessions:timeline { owner:'self' } could
 * both read. Root cause: search/timeline reach the session by SESSION_ID, while
 * list filters session_turns by OWNER — and a managed-Codex-home / history.jsonl
 * live session's turns are indexed under a different owner stamp (or not yet
 * indexed) than the coord ownerId `self` resolves to. list now merges an explicit
 * active-session row (the issue's recommended fix + GUARD: "list/search/timeline
 * must all resolve the same session id"), with OWNER-INDEPENDENT counts so the row
 * matches what search/timeline see.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/sessions/list.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

// Keep SESSION_SOURCE_KINDS / disabledResult real (the tool's z.enum needs the
// former at module load); stub only the two read-path side effects.
vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 1, refreshed: 1 })),
}));

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...a: unknown[]) => resolveSelfSession(...a),
}));

const tool = (await import('./list')).default;

interface ParsedResult {
  ok: boolean;
  count: number;
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  sessions: Array<{
    source_kind: string;
    session_id: string;
    turns: number;
    prompt_count: number;
    owner: string | null;
    active?: boolean;
  }>;
}

/** A stand-in for ctx.tx — each tagged-template call returns the next queued
 *  result set. The handler calls it once for the main owner-filtered query and,
 *  when the fallback fires, once more for the owner-independent aggregate. */
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

describe('sessions:list EI-11403 active-session fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces the caller's LIVE session even when its turns are indexed under another owner", async () => {
    // The owner filter finds nothing (turns stamped with a different owner), but
    // the session_id aggregate — the lens search/timeline use — finds the turns.
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-live', filePath: '/x' });
    const { parsed, txCalls } = await run(
      { owner: 'self', since: '2026-07-13T13:30:00Z' },
      [
        [], // main owner-filtered query → zero rows (the bug)
        [{ turns: 5, prompt_count: 2, harness_slug: 'papercusp', cwd: '/repo', first_ts: '2026-07-13T13:45:00-04:00', last_ts: '2026-07-13T14:10:00-04:00' }],
      ],
    );

    expect(txCalls).toBe(2); // main + fallback aggregate
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    const row = parsed.sessions.find((s) => s.session_id === 'sess-live');
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
    expect(row!.source_kind).toBe('codex');
    expect(row!.turns).toBe(5); // owner-independent count — matches what search sees
    expect(row!.owner).toBe('su-self');
  });

  it('returns an explicit active/unindexed row when the live session has no indexed turns yet', async () => {
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-fresh', filePath: '/x' });
    const { parsed } = await run(
      { owner: 'self' },
      [
        [], // main query → zero rows
        [{ turns: 0, prompt_count: 0, harness_slug: null, cwd: null, first_ts: null, last_ts: null }],
      ],
    );

    const row = parsed.sessions.find((s) => s.session_id === 'sess-fresh');
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
    expect(row!.turns).toBe(0);
  });

  it('does NOT double-list a live session already present in the owner-filtered result', async () => {
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'sess-live', filePath: '/x' });
    const { parsed, txCalls } = await run(
      { owner: 'self' },
      [
        [{ source_kind: 'codex', session_id: 'sess-live', turns: 3, prompt_count: 1, owner: 'su-self', harness_slug: null, cwd: null, first_ts: null, last_ts: null, response_count: null, tool_call_count: null, total_matching: 1 }],
      ],
    );

    expect(txCalls).toBe(1); // no fallback aggregate — the session is already there
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session_id).toBe('sess-live');
    expect(parsed.sessions[0].active).toBeUndefined();
    expect(parsed.count).toBe(1);
  });

  it("scopes the fallback to owner:self — never runs for another agent's owner", async () => {
    const { parsed, txCalls } = await run(
      { owner: 'su-other' },
      [[]], // main query → zero rows
    );

    expect(resolveSelfSession).not.toHaveBeenCalled();
    expect(txCalls).toBe(1); // main query only
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });
});
