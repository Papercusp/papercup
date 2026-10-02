/**
 * read.test.ts — coord:read (EI-9942): a thin wrapper over `../messages`. Mocks
 * that module so this stays a pure handler-contract test; the resolver's own
 * PG-fast-path/fallback behavior is proven in messages-get-by-id.test.ts and is
 * not re-tested here.
 *
 * WI-6725 moved the handler off `getMessageById` onto `resolveMessageRef` (a
 * truncated id now resolves by unique prefix instead of reading as "does not
 * exist"). This factory mock did not gain the new export, so every test in the
 * file threw at the mock boundary — `No "resolveMessageRef" export is defined on
 * the "../messages" mock` — and reds the fleet's green gate. The prefix and
 * ambiguous branches are covered below precisely because their absence is what
 * let the seam change land untested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../messages', () => ({ getMessageById: vi.fn(), resolveMessageRef: vi.fn() }));
// WI-10005375: coord:read folds an escalation's sibling resolve/reopen events through this seam.
vi.mock('../escalations', () => ({
  foldEscalationResolution: vi.fn(async (record: unknown) => record),
}));

import { resolveMessageRef } from '../messages';
import { foldEscalationResolution } from '../escalations';
import { mockResolvedOnceTyped } from '../../../testing/typed-mock';
const resolveRef = vi.mocked(resolveMessageRef);
const foldEscalation = vi.mocked(foldEscalationResolution);
type EscalationFixture = Parameters<typeof foldEscalationResolution>[0];
const tool = (await import('./read')).default;

const envelope = (msgId: string, body = 'x'.repeat(2615)) => ({
  msg_id: msgId,
  from: 'su-l1',
  to: ['su-leader'],
  kind: 'note',
  ts: '2026-07-12T00:00:00Z',
  summary: 'root-cause report',
  body,
});

async function run(args: unknown) {
  const res = (await tool.handler(args as never, {} as never)) as { data?: unknown; content?: { text: string }[] };
  return res.data ?? JSON.parse(res.content![0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coord:read', () => {
  it('found: returns the FULL envelope untruncated, keyed by the requested msg_id', async () => {
    const full = envelope('mrh4rf15'); // the exact oversize scenario EI-9942 reports
    resolveRef.mockResolvedValueOnce({
      status: 'found',
      msgId: 'mrh4rf15',
      message: full,
      resolvedFrom: 'exact',
    } as never);

    const out = await run({ msg_id: 'mrh4rf15' });

    expect(resolveRef).toHaveBeenCalledWith('mrh4rf15');
    expect(out).toMatchObject({ ok: true, found: true, msg_id: 'mrh4rf15' });
    expect(out.message.body).toHaveLength(2615); // no truncation applied anywhere in this path
    // An exact hit must NOT advertise prefix resolution.
    expect(out.resolved_from).toBeUndefined();
    expect(out.resolved_msg_id).toBeUndefined();
  });

  it('not found: found:false, message:null — never throws on an unknown/expired msg_id', async () => {
    resolveRef.mockResolvedValueOnce({
      status: 'not-found',
      msgId: 'nope',
      looksTruncated: false,
    } as never);
    const out = await run({ msg_id: 'nope' });
    expect(out).toMatchObject({ ok: true, found: false, msg_id: 'nope', message: null });
  });

  it('a unique PREFIX resolves, and says so — the WI-6725 false negative', async () => {
    // The failure this replaced: a truncated id returned a well-formed EMPTY
    // result that read exactly like "does not exist", and a leader retracted a
    // real unanswered commitment on it. Resolving silently would be nearly as
    // bad, so the reply must name the full id it actually read.
    resolveRef.mockResolvedValueOnce({
      status: 'found',
      msgId: 'mrh4rf15-0000-abc',
      message: envelope('mrh4rf15-0000-abc', 'resolved'),
      resolvedFrom: 'prefix',
    } as never);

    const out = await run({ msg_id: 'mrh4rf15' });

    expect(out).toMatchObject({
      ok: true,
      found: true,
      msg_id: 'mrh4rf15',
      resolved_msg_id: 'mrh4rf15-0000-abc',
      resolved_from: 'prefix',
    });
    expect(out.detail).toContain('TRUNCATED');
  });

  it('an AMBIGUOUS prefix reports candidates instead of guessing one', async () => {
    resolveRef.mockResolvedValueOnce({
      status: 'ambiguous',
      msgId: 'mrh4',
      candidates: ['mrh4rf15-0000-a', 'mrh4rf15-0000-b'],
    } as never);

    const out = await run({ msg_id: 'mrh4' });

    expect(out).toMatchObject({
      ok: true,
      found: false,
      error: 'msg_id_ambiguous',
      candidates: ['mrh4rf15-0000-a', 'mrh4rf15-0000-b'],
      message: null,
    });
  });

  it('a truncated-looking MISS explains the shape rather than just saying no', async () => {
    resolveRef.mockResolvedValueOnce({
      status: 'not-found',
      msgId: 'mrh4',
      looksTruncated: true,
    } as never);

    const out = await run({ msg_id: 'mrh4' });

    expect(out).toMatchObject({ ok: true, found: false, message: null });
    expect(out.detail).toContain('NOT a full msg_id');
  });

  it('WI-10005375: an escalation is returned with its sibling resolution FOLDED in', async () => {
    // The stored escalation record says resolved:null forever (resolution is a sibling
    // event). Returning it raw made a withdrawn ask read as still open.
    const raw: EscalationFixture = {
      ...envelope('muqn4z3z'),
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      resolved: null,
    };
    mockResolvedOnceTyped(resolveRef, { status: 'found', msgId: 'muqn4z3z', message: raw, resolvedFrom: 'exact' });
    const resolved: NonNullable<EscalationFixture['resolved']> = {
      by: 'su-4d390264',
      choice: 'superseded',
      ts: '2026-10-02T07:54:42Z',
    };
    mockResolvedOnceTyped(foldEscalation, { ...raw, resolved });

    const out = await run({ msg_id: 'muqn4z3z' });

    expect(foldEscalation).toHaveBeenCalledTimes(1);
    expect(foldEscalation).toHaveBeenCalledWith(raw);
    expect(out).toMatchObject({ ok: true, found: true });
    expect(out.message.resolved).toEqual(resolved);
  });

  it('WI-10005375: a non-escalation message is never routed through the escalation fold', async () => {
    mockResolvedOnceTyped(resolveRef, {
      status: 'found',
      msgId: 'mrh4rf15',
      message: { ...envelope('mrh4rf15'), kind: 'message' },
      resolvedFrom: 'exact',
    });
    await run({ msg_id: 'mrh4rf15' });
    expect(foldEscalation).not.toHaveBeenCalled();
  });
});

describe('coord:read structured response', () => {
  it('preserves an oversized envelope through structuredContent', async () => {
    resolveRef.mockResolvedValueOnce({
      status: 'found',
      msgId: 'mrh4rf15',
      message: envelope('mrh4rf15'),
      resolvedFrom: 'exact',
    } as never);

    const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('coord:read')!;
    const dispatched = await dispatchProjectedTool(
      projected,
      'coord:read',
      { msg_id: 'mrh4rf15' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'coord-read-structured-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: vi.fn(async () => []),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      found: true,
      msg_id: 'mrh4rf15',
    });
    const structured = dispatched.result?.structuredContent as { message: { body: string } };
    expect(structured.message.body).toHaveLength(2615);
  });
});
