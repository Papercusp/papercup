/**
 * wake-executor.test.ts — the liveness ladder, pure (injected deps, no PG)
 * (await-event-primitive-2026-06-05 P-006, D-003/D-009).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHomeForAdvSession,
  executeWake,
  findCodexRolloutSessionId,
  injectOmpWakeTurnWhenReady,
  hiveInstallSlugFromLabel,
  ompResumePtyLooksReady,
  resumeCommandFor,
  wakeTurnText,
  degradeToInboxOrDrop,
  rehydrateLoopWakeText,
  applyInjectionDoor,
  type ExecuteWakeDeps,
} from './wake-executor';
// EI-20489286325396940: `wakeSummaryHeadline` (with `payloadIsTimeout`) lives in
// timeout-fallback.ts, not wake-executor.ts — it is imported BY wake-executor and
// by engine.ts, so hosting it here would close a wake-executor↔engine import cycle.
import { wakeSummaryHeadline } from './timeout-fallback';
import { PtyError } from '../../pty-bridge';
import type { CarryBrief } from '../../carry-brief';
import { renderColdWakeInjection } from '../../su-cold-loop';
import type { DeliveryWork, WakeHandle } from './types';

// A per-session codex home (session-42) with two rollouts; the newer UUID wins.
const ROLLOUT_UUID = '019ea541-e6ed-71c2-bc67-aa25b5164ec5';
let CODEX_HOMES_DIR = '';
let prevCodexHomesEnv: string | undefined;

beforeAll(() => {
  CODEX_HOMES_DIR = mkdtempSync(join(tmpdir(), 'wake-codex-'));
  const sessionsDir = join(CODEX_HOMES_DIR, 'session-42', 'sessions', '2026', '06', '07');
  mkdirSync(sessionsDir, { recursive: true });
  const oldRollout = join(sessionsDir, 'rollout-2026-06-07T10-00-00-00000000-0000-0000-0000-000000000000.jsonl');
  const newRollout = join(sessionsDir, `rollout-2026-06-07T23-23-40-${ROLLOUT_UUID}.jsonl`);
  writeFileSync(oldRollout, '{}');
  writeFileSync(newRollout, '{}');
  utimesSync(oldRollout, new Date('2026-06-01'), new Date('2026-06-01'));
  utimesSync(newRollout, new Date('2026-06-07'), new Date('2026-06-07'));
  prevCodexHomesEnv = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = CODEX_HOMES_DIR;
});

afterAll(() => {
  if (prevCodexHomesEnv === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = prevCodexHomesEnv;
  try {
    rmSync(CODEX_HOMES_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function work(overrides: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 7,
    workspaceId: 'ws',
    awaitId: 3,
    subscriberId: 'su-abc',
    eventKey: 'lock:grant:t-1',
    payload: null,
    summary: 'your lock on foo.ts was granted',
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    wakeHandle: null,
    note: 'waiting to edit foo.ts',
    ...overrides,
  };
}

const advHandle = (over: Partial<Extract<WakeHandle, { kind: 'adv-session' }>> = {}): WakeHandle => ({
  kind: 'adv-session',
  advSessionId: 42,
  agent: 'claude',
  sessionId: '11111111-2222-3333-4444-555555555555',
  ompThreadId: null,
  cwd: '/repo',
  pid: 9999,
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 42,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console' as const,
  terminalBin: null,
  pid: 9999,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-abc',
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  ...over,
});

const livePresence = { stale: false, revoked: false };
const stalePresence = { stale: true, revoked: false };

function fakeOmpPty(id = 'pty-omp') {
  return {
    id,
    onData: new Set<(chunk: Buffer) => void>(),
    onExit: new Set<(code: number, signal: number) => void>(),
    history: [] as Buffer[],
    killed: false,
    exitCode: null as number | null,
  };
}

function deps(over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
  return {
    getSession: vi.fn(async () => session()) as never,
    findPty: vi.fn(() => null) as never,
    write: vi.fn(() => true) as never,
    spawnManagedPty: vi.fn(() => ({ id: 'pty-1' })) as never,
    spawnDetached: vi.fn(() => 1234),
    presence: vi.fn(async () => livePresence) as never,
    getSessionLifecycle: vi.fn(async () => null),
    alive: vi.fn(() => true),
    isLoopArmed: vi.fn(async () => false),
    // WI-6860: hermetic by default — the real getLoopStatus opens a live PG
    // connection (getOrgPg), which a unit test must never touch. Only the
    // EI-19294445744419497 staleness-hint branch (noteUpdatedAtMs != null)
    // reads this; default to "no status" so that branch's staleness hint is
    // simply omitted unless a test overrides it.
    getLoopStatusFn: vi.fn(async () => null) as never,
    forceResume: vi.fn(async () => false),
    resumePlanRun: vi.fn(async () => ({ ok: true as const })),
    // Hermetic by default: no live psu-pty host (don't read the real ~/.papercusp).
    findPsuHost: vi.fn(() => null) as never,
    injectPsuHost: vi.fn(async () => true) as never,
    // Hermetic by default: the hive-fresh-wake fire is stubbed so a hive-labelled
    // session never reaches the real default (which lazy-imports + touches PG).
    fireHiveWake: vi.fn(async () => true) as never,
    // Hermetic by default: the degrade-to-inbox send is stubbed so a dead-waiter
    // drop path never reaches the real sendMessage (which touches PG/coordLog).
    sendCoordMessage: vi.fn(async () => ({}) as never) as never,
    // Hermetic by default (P-008 rematerialize-on-miss): the resume leg calls these
    // before `--resume`. Their real bindings READ PG, and an unsettled PG read HANGS
    // past the surrounding try/catch rather than throwing — un-stubbed, every resume
    // test blocks until the suite timeout. collectSessionFiles returns a non-empty
    // list = the "transcript already on disk" fast path, so rematerialize never fires.
    collectSessionFiles: vi.fn(async () => [{}]) as never,
    rematerializeSession: vi.fn(async () => ({ ok: true, written: 0 })) as never,
    findArchivedSessionIdForAdv: vi.fn(async () => null) as never,
    // Hermetic by default (turn-provenance P-002): the real tagger writes ledger
    // rows under ~/.papercusp/turn-provenance — stub it to a passthrough so the
    // long-standing exact-text assertions stay byte-identical. The dedicated
    // provenance-tagging describe below injects a REAL-shaped tagger instead.
    tagTurn: ((args: { text: string; origin: string }) => ({
      taggedText: args.text,
      envelope: '',
      nonce: 'stub',
      origin: args.origin,
      ledgerWritten: true,
    })) as never,
    ...over,
  };
}

describe('executeWake — durable fleet release latch (EI-203843)', () => {
  it('drops every wake shape before any injection or resume side effect', async () => {
    const lifecycle = {
      released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' },
    };
    const cases = [
      work({ wakeHandle: null }),
      work({ wakeHandle: { kind: 'plan-run', runId: 12 } }),
      work({ wakeHandle: advHandle() }),
    ];
    for (const delivery of cases) {
      const d = deps({ getSessionLifecycle: vi.fn(async () => lifecycle) });
      const out = await executeWake(delivery, d);
      expect(out).toMatchObject({ kind: 'drop' });
      expect((out as { reason: string }).reason).toContain('released');
      expect((out as { reason: string }).reason).toContain('end now');
      expect(d.findPsuHost).not.toHaveBeenCalled();
      expect(d.spawnDetached).not.toHaveBeenCalled();
      expect(d.resumePlanRun).not.toHaveBeenCalled();
      expect(d.write).not.toHaveBeenCalled();
    }
  });

  it('continues the normal ladder when no release marker is present', async () => {
    const d = deps({
      getSessionLifecycle: vi.fn(async () => null),
      presence: vi.fn(async () => stalePresence) as never,
    });
    await expect(executeWake(work({ wakeHandle: null }), d)).resolves.toMatchObject({
      kind: 'delivered',
      channel: 'inbox',
    });
  });
});

describe('executeWake ambient-push seam (P-003, DEFAULT-OFF)', () => {
  const OLD_FLAG = process.env.PAPERCUSP_AMBIENT_CURSOR;
  afterEach(() => {
    if (OLD_FLAG === undefined) delete process.env.PAPERCUSP_AMBIENT_CURSOR;
    else process.env.PAPERCUSP_AMBIENT_CURSOR = OLD_FLAG;
  });

  // Handle-less path with no psu host + stale presence → degrade-to-inbox; the
  // ambient prep runs at the top of executeWake regardless of the outcome path.
  it('invokes prepareAmbientPushBlock (keyed by ownerId) when the flag is ON', async () => {
    process.env.PAPERCUSP_AMBIENT_CURSOR = '1';
    const prep = vi.fn(async () => '⟦ambient⟧ ‼ x — pull: session:su-y');
    await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).toHaveBeenCalledWith({ ownerId: 'su-abc' });
  });

  it('does NOT invoke prepareAmbientPushBlock when the flag is OFF (DEFAULT-OFF)', async () => {
    delete process.env.PAPERCUSP_AMBIENT_CURSOR;
    const prep = vi.fn(async () => 'x');
    await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).not.toHaveBeenCalled();
  });

  it('an ambient-prep throw never breaks the wake (fail-soft)', async () => {
    process.env.PAPERCUSP_AMBIENT_CURSOR = '1';
    const prep = vi.fn(async () => {
      throw new Error('store down');
    });
    // stale presence + no psu host → the wake still degrades to inbox, not a throw.
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ prepareAmbientPushBlock: prep, presence: vi.fn(async () => stalePresence) as never }),
    );
    expect(prep).toHaveBeenCalled();
    expect(out.kind).not.toBe('error');
  });
});

describe('wakeTurnText', () => {
  it('carries the key, summary, note and a bounded payload on one line', () => {
    const t = wakeTurnText(work({ payload: { x: 'y'.repeat(1000) } }));
    expect(t).toContain('lock:grant:t-1');
    expect(t).toContain('your lock on foo.ts was granted');
    expect(t).toContain('waiting to edit foo.ts');
    expect(t).not.toContain('\n');
    expect(t.length).toBeLessThan(700);
  });

  /**
   * EI-20130618357432548 — the owner's chat-pane message is delivered AS the turn.
   * Everything the wrapper adds (event key, delivery id, inbox-wake reconcile note)
   * is correct for an agent/system wake and wrong here: the chat pane renders this
   * transcript back to the OWNER, so the wrapper is what they read instead of their
   * own message, and its text is what defeated the pane's echo absorption.
   */
  it('delivers an OWNER CHAT-PANE message as the turn itself — no [await-event] wrapper', () => {
    const t = wakeTurnText(
      work({
        eventKey: 'coord:inbox-wake:su-abc',
        summary: 'hi',
        payload: { msg_id: 'm1', ownerChatTurn: true, ownerChatText: 'hi' },
      }),
    );
    expect(t.startsWith('hi\n\n')).toBe(true);
    expect(t).not.toContain('[await-event]');
    expect(t).not.toContain('delivery #');
    expect(t).not.toContain('NOTE (inbox-wake)');
    // …and it tells the agent where its answer is actually read, which is what
    // stopped the doomed coord reply + `human` hedge (EI-20130675657060052).
    expect(t).toContain('⟦owner-chat⟧');
  });

  /**
   * P-022 / D-007 — the prepared cell fold is RENDERED. The block is built in the async
   * delivery path (cell-wake-fold.ts, covered in its own suite); this pins the other
   * half of the seam, which is the half that silently does nothing if it regresses.
   */
  it('renders the P-022 cell fold, and puts it BEFORE the ambient block', () => {
    const t = wakeTurnText(
      work({ cellWakeFoldBlock: '[cell] gate.x = green', ambientPushBlock: '[ambient] …' }),
    );
    expect(t).toContain('[cell] gate.x = green');
    // Next to the `payload` value it corrects, not below unrelated ambient material.
    expect(t.indexOf('[cell]')).toBeLessThan(t.indexOf('[ambient]'));
    expect(t).toContain('[await-event]');
  });

  it('is byte-identical when no cell fold was prepared — the default path', () => {
    const base = work({ payload: { x: 1 } });
    expect(wakeTurnText(base)).toBe(wakeTurnText({ ...base, cellWakeFoldBlock: undefined }));
  });

  it('carries a LONG owner message in full — the wake summary is truncated, the payload is not', () => {
    const long = 'please '.repeat(40).trim();
    const t = wakeTurnText(
      work({ summary: `${long.slice(0, 77)}…`, payload: { ownerChatTurn: true, ownerChatText: long } }),
    );
    expect(t.startsWith(long)).toBe(true);
    expect(t).not.toContain('…');
  });

  it('leaves every ordinary wake BYTE-IDENTICAL — the owner path is opt-in via the marker', () => {
    const plain = work({ payload: { msg_id: 'm1' } });
    expect(wakeTurnText(plain)).toContain('[await-event]');
    // A malformed marker must fall through to the ordinary wrapper, never produce
    // an empty turn.
    expect(wakeTurnText(work({ payload: { ownerChatTurn: true } }))).toContain('[await-event]');
    expect(wakeTurnText(work({ payload: { ownerChatTurn: true, ownerChatText: '  ' } }))).toContain(
      '[await-event]',
    );
  });

  it('marks a timeout wake loudly', () => {
    const t = wakeTurnText(work({ payload: { timeout: true } }));
    expect(t).toContain('TIMEOUT');
    expect(t).toContain('did NOT fire');
    // EI-20489286325396940: name the authoritative column so the reader never has
    // to open events:status to learn WHY the wake fired.
    expect(t).toContain('fired_reason: timeout');
  });

  /**
   * EI-20489286325396940 — a timed-out await must never render as its source
   * COMPLETING. Verified live 2026-08-15: `work-item:done:WI-39195 fired` was
   * injected while WI-39195 stayed open and blocked; the authoritative row was
   * `fired_reason='timeout'` at `expires_ts` and no completion was ever emitted.
   * The wake BODY already carried `[TIMEOUT …]`; the coord-message SUMMARY — which
   * is what the injected `[coord+N]` block actually renders — did not.
   */
  describe('wakeSummaryHeadline (EI-20489286325396940)', () => {
    const DONE_KEY = 'work-item:done:WI-39195';

    it('renders a timeout as TIMED OUT with fired_reason — never as "fired"', () => {
      const s = wakeSummaryHeadline(DONE_KEY, { timeout: true });
      expect(s).toContain('TIMED OUT');
      expect(s).toContain('fired_reason: timeout');
      // The whole defect: the completion inference. `<key> fired` must not appear.
      expect(s).not.toContain(`${DONE_KEY} fired`);
      expect(s).toContain('did NOT complete');
    });

    it('leaves a genuine event fire byte-identical', () => {
      expect(wakeSummaryHeadline(DONE_KEY, { workItemId: 'WI-39195' })).toBe(
        `[await-event] ${DONE_KEY} fired`,
      );
      expect(wakeSummaryHeadline(DONE_KEY, null)).toBe(`[await-event] ${DONE_KEY} fired`);
    });

    // A coalesced wake replaces the headline payload with {coalesced,…}, hiding the
    // raw `timeout` flag behind `latest`/`events` — the marker must survive both.
    it('sees through a coalesced payload', () => {
      expect(wakeSummaryHeadline(DONE_KEY, { coalesced: true, latest: { payload: { timeout: true } } }))
        .toContain('TIMED OUT');
      expect(wakeSummaryHeadline(DONE_KEY, { coalesced: true, events: [{ payload: { timeout: true } }] }))
        .toContain('TIMED OUT');
    });

    it('degradeToInboxOrDrop sends a timeout summary that cannot read as completion', async () => {
      const sent: { summary?: string; body?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string; body?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      const outcome = await degradeToInboxOrDrop(
        work({ eventKey: DONE_KEY, payload: { timeout: true }, summary: null }),
        'no live pty',
        send,
      );

      expect(outcome).toEqual({ kind: 'delivered', channel: 'inbox' });
      expect(sent).toHaveLength(1);
      expect(sent[0].summary).toContain('TIMED OUT');
      expect(sent[0].summary).toContain('fired_reason: timeout');
      expect(sent[0].summary).not.toContain(`${DONE_KEY} fired`);
      // The delivery-mechanism reason is still carried alongside it.
      expect(sent[0].summary).toContain('no live pty');
    });

    it('degradeToInboxOrDrop still says "fired" for a real event', async () => {
      const sent: { summary?: string }[] = [];
      const send = (async (_identity: unknown, opts: { summary?: string }) => {
        sent.push(opts);
        return {} as never;
      }) as unknown as Parameters<typeof degradeToInboxOrDrop>[2];

      await degradeToInboxOrDrop(work({ eventKey: DONE_KEY, payload: null }), 'no live pty', send);
      expect(sent[0].summary).toBe(
        `[await-event] ${DONE_KEY} fired — delivered to your coord inbox (no live pty)`,
      );
    });
  });

  // ambient-semantic-push P-003 seam: a prepared ambient push block rides the wake
  // injection when present (appended after the base line-collapse, keeping its own
  // formatting), and the default path is byte-identical.
  it('appends the ambient push block when present, on its own lines', () => {
    const block = '⟦ambient⟧\n‼ peer converging — pull: session:su-x [foo, bar]';
    const t = wakeTurnText(work({ ambientPushBlock: block }));
    expect(t).toContain('lock:grant:t-1'); // base wake still present
    expect(t).toContain('⟦ambient⟧');
    expect(t).toContain('pull: session:su-x');
    expect(t.endsWith(block)).toBe(true); // block is the tail, un-collapsed
  });

  it('is byte-identical to the base wake when no ambient block is set (DEFAULT-OFF)', () => {
    const base = wakeTurnText(work());
    const withUndef = wakeTurnText(work({ ambientPushBlock: undefined }));
    expect(withUndef).toBe(base);
    expect(base).not.toContain('⟦ambient⟧');
  });

  // EI-16648: an always-armed inbox-wake (`coord:inbox-wake:<owner>`) can be
  // CONSUMED late — a continuously-busy recipient's OWN periodic coord:inbox
  // polling may already have surfaced + handled the quoted message before the
  // injected wake turn is drained. So an inbox-wake key gets a self-identifying
  // reconciliation NOTE telling the woken agent to reconcile against the
  // cursor-free coord:inbox VIEW before re-doing possibly-already-handled mail;
  // every OTHER key is untouched. D-013 keeps the agent-facing cursor out of
  // coord:inbox, so this note must never reintroduce a since_ts call shape.
  it('EI-16648/D-013: an inbox-wake key stamps the cursor-free coord:inbox note', () => {
    const t = wakeTurnText(work({ eventKey: 'coord:inbox-wake:su-abc' }));
    expect(t).toContain('coord:inbox-wake:su-abc'); // base wake still present
    expect(t).toContain('NOTE (inbox-wake)');
    expect(t).toContain('reconcile against coord:inbox');
    expect(t).toContain("coord:inbox's cursor-free VIEW");
    expect(t).not.toContain('since_ts');
    expect(t).toContain('do NOT re-do handled mail');
    expect(t).not.toContain('\n'); // still a single collapsed line
  });

  it('EI-16648: a non-inbox-wake key is byte-identical — NO reconcile note', () => {
    const t = wakeTurnText(work()); // default eventKey 'lock:grant:t-1'
    expect(t).not.toContain('NOTE (inbox-wake)');
    expect(t).not.toContain('reconcile against coord:inbox');
  });

  // GAP 1 (likely bug): a timeout-fire payload `{timeout:true}` coalesced with a
  // sibling has its headline payload replaced by `{coalesced,count,events,latest}`
  // (coalesceDeliveries) — the top-level `timeout` marker is GONE. wakeTurnText
  // must still surface [TIMEOUT] by looking inside the union, or the woken agent is
  // told the event FIRED when it actually TIMED OUT.
  it('coalesced timeout wake STILL emits [TIMEOUT] (GAP 1: the marker survives coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The newest (headline) delivery is the timeout fire; an earlier sibling is a
    // normal event fire — exactly the engine.ts sweeper + pump interleaving.
    const sibling = work({ id: 30, eventKey: 'lock:grant:t-1', payload: null, createdAt: new Date(1000).toISOString() });
    const timeoutHeadline = work({
      id: 31,
      eventKey: 'plan-run:finished:9',
      payload: { timeout: true },
      summary: 'await deadline passed without the event firing',
      createdAt: new Date(2000).toISOString(),
    });
    const coalesced = coalesceDeliveries([sibling, timeoutHeadline]);
    // The headline payload IS the union now — proves the raw `.timeout` is buried.
    expect((coalesced.payload as { coalesced?: boolean }).coalesced).toBe(true);
    expect((coalesced.payload as { timeout?: boolean }).timeout).toBeUndefined();
    // ...yet the wake turn still warns the agent the event TIMED OUT.
    const t = wakeTurnText(coalesced);
    expect(t).toMatch(/TIMEOUT/);
    expect(t).toContain('did NOT fire');
  });

  it('coalesced timeout in a FOLDED sibling (not the headline) also surfaces [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The timeout is the OLDER fire; the newest is a normal event → the marker
    // lives only in `events[]`, not in `latest`. Still must surface.
    const timeoutSibling = work({ id: 40, payload: { timeout: true }, createdAt: new Date(1000).toISOString() });
    const eventHeadline = work({ id: 41, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([timeoutSibling, eventHeadline]));
    expect(t).toMatch(/TIMEOUT/);
  });

  it('a coalesced group with NO timeout does not emit a spurious [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const a = work({ id: 50, payload: { ok: true }, createdAt: new Date(1000).toISOString() });
    const b = work({ id: 51, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([a, b]));
    expect(t).not.toContain('TIMEOUT');
  });

  it('single-delivery timeout path still works (no coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // group.length === 1 → coalesceDeliveries returns the headline unchanged, so
    // the plain `{timeout:true}` path is untouched by the GAP 1 fix.
    const single = coalesceDeliveries([work({ id: 60, payload: { timeout: true } })]);
    expect((single.payload as { timeout?: boolean }).timeout).toBe(true);
    expect(wakeTurnText(single)).toMatch(/TIMEOUT/);
  });
});

describe('rehydrateLoopWakeText (EI-10935: delivery-time carry-note re-check)', () => {
  const STALE_TEXT =
    'Loop fired.\n\n⛔ OPEN WALLS — owner-gated / pending decisions:\n  • LIVE entity re-link backfill — irreversible, awaiting go/no-go';

  it('a NON-loop wake (no marker on payload) is byte-identical — no carry-note read at all', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({ note: null, updatedAtMs: null }));
    const d = work({ payload: null });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toBe(STALE_TEXT);
    expect(getLoopCarryNoteWithMetaFn).not.toHaveBeenCalled();
  });

  it('a LOOP wake whose FRESH carry-note now has NO open walls explicitly says so — supersedes a stale OPEN WALLS block above (the exact EI-10935 regression)', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nCleared the wall after the owner go-ahead; candidate 29e97a6761 is current.\n\n## Left\nNothing.\n\n## Next action\nRe-check 29e97a6761.',
      updatedAtMs: Date.now() - 5_000,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 5 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-loop-1',
      workspaceId: d.workspaceId,
    });
    // The stale text is still present (never mutated/removed)...
    expect(out).toContain(STALE_TEXT);
    // ...but a live re-check block is prepended, EXPLICITLY stating no walls are
    // open now — the delivery-time state leads the stale snapshot and cannot be
    // lost to the injection door's head-keep cap.
    expect(out).toMatch(/LIVE RE-CHECK/);
    expect(out).toContain('candidate 29e97a6761 is current');
    expect(out).toMatch(/none open — any wall shown OPEN above has been CLEARED since/);
    expect(out).toMatch(/TRUST THIS BLOCK/);
    // The delivery-time block leads the fire-time snapshot so the injection door's
    // head-keep behavior cannot spill the only state that was read at delivery.
    expect(out.indexOf('LIVE RE-CHECK')).toBeLessThan(out.indexOf(STALE_TEXT));
  });

  it('a LOOP wake whose FRESH carry-note STILL has an open wall renders it in the re-check block', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Did\nStill mid-way.\n\n## Walls\n- a genuinely still-open irreversible action',
      updatedAtMs: Date.now() - 1_000,
    }));
    const d = work({ payload: { harness: 'papercusp', wakeCount: 2 }, subscriberId: 'su-loop-2' });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toMatch(/LIVE RE-CHECK/);
    expect(out).toContain('a genuinely still-open irreversible action');
  });

  it('fails soft to the original text when the fresh carry-note read throws', async () => {
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => {
      throw new Error('pg unreachable');
    });
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 } });
    const out = await rehydrateLoopWakeText(d, STALE_TEXT, { getLoopCarryNoteWithMetaFn });
    expect(out).toContain(STALE_TEXT);
    expect(out).toMatch(/LOOP CHECKPOINT RE-CHECK FAILED/);
  });

  it('keeps the delivery-time narrative checkpoint ahead of the injection-door spill (EI-20230529647745311)', async () => {
    const d = work({
      id: 990_002,
      subscriberId: 'su-loop-door-regression',
      payload: { harness: 'papercusp', wakeCount: 2 },
    });
    const current = await rehydrateLoopWakeText(
      d,
      `STALE-CANDIDATE-7e0e5011\n${'old fire-time snapshot '.repeat(2_000)}`,
      {
        getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
          note: '## Did\nVerified candidate 29e97a6761 after loop:checkpoint write.\n\n## Next action\nWait for its verdict.',
          updatedAtMs: Date.now() - 1_000,
        })),
      },
    );
    const delivered = applyInjectionDoor(d, current);
    try {
      expect(delivered).toContain('candidate 29e97a6761');
      expect(delivered.indexOf('LIVE RE-CHECK')).toBeLessThan(delivered.indexOf('STALE-CANDIDATE-7e0e5011'));
      expect(delivered).toMatch(/injection-door: wake text exceeded/);
    } finally {
      const m = delivered.match(/the FULL text is at (\S+) —/);
      if (m) rmSync(m[1], { force: true });
    }
  });
});

describe('rehydrateLoopWakeText — EI-18825117783927950 (loop:end / re-arm does not drain an already-queued fire)', () => {
  const FROZEN_TEXT =
    "Loop wake. Continue working plan foo. Current loop:checkpoint — this is the authority for what to do this wake.";
  const noWalls = async () => ({ note: null, updatedAtMs: Date.now() - 2_000 });

  function loopStatus(over: Partial<import('../../harness/routines/loop').LoopStatus> = {}) {
    return {
      name: 'loop_su-loop',
      ownerId: 'su-loop-1',
      harnessSlug: 'papercusp',
      active: true,
      intervalSec: 60,
      carry: 'warm' as const,
      continuation: 'settle' as const,
      mode: 'work' as const,
      goal: null,
      fireCount: 3,
      firesSinceArm: 3,
      expectedFiresSinceArm: null,
      effectiveIntervalSec: null,
      cadenceRatio: null,
      longestObservedGapSec: null,
      parked: false,
      nextFireAt: null,
      lastFiredAt: null,
      armedAt: new Date(Date.now() - 100_000).toISOString(),
      costCapCents: null,
      maxFires: null,
      maxDurationSec: null,
      stalled: false,
      stalledSinceMs: null,
      lastDeliveryOutcome: null,
      consecutiveErrors: 0,
      lastWakeChannel: null,
      lastWakeStatus: null,
      lastWakeAt: null,
      lastWakeError: null,
      lastTurnAt: null,
      lastRealTurnAt: null,
      turnsStalled: false,
      lifecycleBackoff: null,
      ...over,
    };
  }

  it('a fire queued while active, delivered after loop:end (active:false), is banner-flagged as SUPERSEDED', async () => {
    const getLoopStatusFn = vi.fn(async () => loopStatus({ active: false }));
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 12 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(getLoopStatusFn).toHaveBeenCalledWith('su-loop-1');
    // The frozen text is preserved, never mutated/removed...
    expect(out).toContain(FROZEN_TEXT);
    // ...but a loud, unmissable banner tells the receiving agent it is stale.
    expect(out).toMatch(/THIS LOOP WAS ENDED/);
    expect(out).toMatch(/NOT authoritative/);
    expect(out).toMatch(/do not resume, re-open, or re-do work/);
  });

  it('no loop routine row at all for this owner (status null) is ALSO treated as ended/superseded', async () => {
    const getLoopStatusFn = vi.fn(async () => null);
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).toMatch(/THIS LOOP WAS ENDED/);
  });

  it('a fire queued before a RE-ARM (armedAt newer than the delivery\'s createdAt) is banner-flagged as superseded, even though active is still true', async () => {
    const getLoopStatusFn = vi.fn(async () =>
      loopStatus({ active: true, armedAt: new Date(Date.now() - 5_000).toISOString() }),
    );
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 4 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(Date.now() - 600_000).toISOString(), // long before the re-arm above
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).toMatch(/THIS LOOP WAS RE-ARMED/);
    expect(out).toMatch(/PRIOR arm/);
  });

  it('a fire queued AFTER the current arm (the normal case) carries NO superseded banner', async () => {
    const armedAtMs = Date.now() - 600_000;
    const getLoopStatusFn = vi.fn(async () => loopStatus({ active: true, armedAt: new Date(armedAtMs).toISOString() }));
    const d = work({
      payload: { harness: 'papercusp', wakeCount: 4 },
      subscriberId: 'su-loop-1',
      createdAt: new Date(armedAtMs + 60_000).toISOString(), // created well after the arm
    });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    expect(out).not.toMatch(/THIS LOOP WAS ENDED/);
    expect(out).not.toMatch(/THIS LOOP WAS RE-ARMED/);
  });

  it('fails soft — a getLoopStatusFn throw degrades only the superseded banner, never the walls/checks rehydration', async () => {
    const getLoopStatusFn = vi.fn(async () => {
      throw new Error('pg unreachable');
    });
    const d = work({ payload: { harness: 'papercusp', wakeCount: 1 }, subscriberId: 'su-loop-1' });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, {
      getLoopCarryNoteWithMetaFn: noWalls,
      getLoopStatusFn,
    });
    // Still gets the base EI-10935 live re-check block...
    expect(out).toMatch(/LIVE RE-CHECK/);
    // ...but no superseded banner (the status read failed, so it says nothing rather
    // than guessing).
    expect(out).not.toMatch(/THIS LOOP WAS ENDED/);
    expect(out).not.toMatch(/THIS LOOP WAS RE-ARMED/);
  });

  it('a NON-loop wake never calls getLoopStatusFn at all (no marker ⇒ early return, byte-identical)', async () => {
    const getLoopStatusFn = vi.fn(async () => loopStatus({ active: false }));
    const d = work({ payload: null });
    const out = await rehydrateLoopWakeText(d, FROZEN_TEXT, { getLoopStatusFn });
    expect(out).toBe(FROZEN_TEXT);
    expect(getLoopStatusFn).not.toHaveBeenCalled();
  });
});

describe('resumeCommandFor', () => {
  it('claude: exact-session resume with the prompt as positional arg', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    expect(r).not.toBeNull();
    expect(r!.bin).toBe('claude');
    expect(r!.args).toContain('--resume');
    expect(r!.args).toContain('sid-1');
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
    expect(r!.promptViaPty).toBe(false);
  });

  it('claude: re-arms the native-scheduler lockout on every wake as ONE `=` token before the positional prompt', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    const denyIdx = r!.args.findIndex((a) => a.startsWith('--disallowedTools='));
    expect(denyIdx).toBeGreaterThan(-1);
    // The single-token form is load-bearing: the variadic space form would
    // consume the trailing wake text as deny rules (D-002,
    // native-scheduler-lockout-2026-06-09).
    expect(r!.args[denyIdx]).toContain('ScheduleWakeup');
    expect(r!.args[denyIdx]).toContain('CronCreate');
    expect(/\s/.test(r!.args[denyIdx])).toBe(false);
    expect(denyIdx).toBeLessThan(r!.args.length - 1); // wake text still trails
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
  });

  it('claude: re-arms the subagent-fanout deny on every wake (owner mandate 2026-07-02) — a woken bee never regains Task/Agent', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    // Spawn-time --disallowedTools doesn't persist into a resume, so it must be
    // re-armed every wake — same persistence gap the scheduler deny addresses. Carried
    // as its own single `=` token alongside the scheduler one (claude unions them).
    const subagentDeny = r!.args.find((a) => a.startsWith('--disallowedTools=') && a.includes('Task') && a.includes('Agent'));
    expect(subagentDeny).toBeDefined();
    expect(/\s/.test(subagentDeny!)).toBe(false);
    expect(r!.args[r!.args.length - 1]).toBe('WAKE'); // wake text still trails
  });

  it('claude WITHOUT a native session id is NOT resumable (no --continue on a shared cwd)', () => {
    expect(resumeCommandFor({ agent: 'claude', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('claude tracked-hive resume remounts the persistent signed MCP config (D-010 resume leg)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'session-mcp-'));
    const prev = process.env.PAPERCUSP_SESSION_MCP_DIR;
    process.env.PAPERCUSP_SESSION_MCP_DIR = root;
    try {
      mkdirSync(join(root, 's-123-queen'), { recursive: true });
      writeFileSync(join(root, 's-123-queen', '.mcp.json'), '{"mcpServers":{}}');

      const r = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-123-queen' },
        'WAKE',
      );
      expect(r!.args).toContain('--mcp-config');
      expect(r!.args).toContain(join(root, 's-123-queen', '.mcp.json'));
      expect(r!.args).toContain('--strict-mcp-config');
      // Prompt stays the trailing positional arg.
      expect(r!.args[r!.args.length - 1]).toBe('WAKE');

      // No config on disk for this owner → resume still works, just no remount.
      const bare = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-nope' },
        'WAKE',
      );
      expect(bare!.args).not.toContain('--mcp-config');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SESSION_MCP_DIR;
      else process.env.PAPERCUSP_SESSION_MCP_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omp: thread resume defaults to headless one-turn with the wake prompt', () => {
    const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
    expect(r!.bin).toBe('omp');
    expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo', '-p', 'WAKE']);
    expect(r!.promptViaPty).toBe(false);
  });

  it('omp: can fall back to PTY injection for older builds', () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    try {
      const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
      expect(r!.bin).toBe('omp');
      expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo']);
      expect(r!.promptViaPty).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp readiness detector recognizes prompt-like resume screens', () => {
    expect(ompResumePtyLooksReady('OMP ready\n> ')).toBe(true);
    expect(ompResumePtyLooksReady('Type a message to continue')).toBe(true);
    expect(ompResumePtyLooksReady('booting provider adapters...')).toBe(false);
  });

  it('codex: headless `exec resume <uuid> <prompt>` when the conversation id is known', () => {
    const r = resumeCommandFor({ agent: 'codex', sessionId: ROLLOUT_UUID, ompThreadId: null }, 'WAKE');
    expect(r!.bin).toBe('codex');
    expect(r!.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      ROLLOUT_UUID,
      'WAKE',
    ]);
    expect(r!.promptViaPty).toBe(false);
  });

  it('codex: null without a conversation id (executeWake recovers it; null → park)', () => {
    expect(resumeCommandFor({ agent: 'codex', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('unknown client: null', () => {
    expect(resumeCommandFor({ agent: null, sessionId: 'sid', ompThreadId: null }, 'WAKE')).toBeNull();
  });
});

describe('executeWake — the liveness ladder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no handle + live presence → park (inbox-only reachability)', async () => {
    const out = await executeWake(work({ wakeHandle: null }), deps());
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('no handle + stale presence (headless waiter) → DEGRADES to a coord inbox notification, not a drop (P-001)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ presence: vi.fn(async () => stalePresence) as never, sendCoordMessage: sendCoordMessage as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendCoordMessage.mock.calls[0] as unknown as [
      { workspaceId: string },
      { to: string[]; summary: string; body: string },
    ];
    expect(identity.workspaceId).toBe('ws');
    expect(opts.to).toEqual(['su-abc']);
    expect(opts.summary).toContain('dead waiter');
    expect(opts.body).toContain('lock:grant:t-1');
  });

  it('no handle + stale presence, but even the inbox send FAILS → still drops, visibly (no resolvable owner)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        presence: vi.fn(async () => stalePresence) as never,
        sendCoordMessage: vi.fn(async () => {
          throw new Error('no such owner');
        }) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'drop' });
    expect((out as { reason: string }).reason).toContain('dead waiter');
    expect((out as { reason: string }).reason).toContain('no such owner');
  });

  it('live waiter still gets a pty wake (the inbox degrade never shadows a live inject)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const write = vi.fn(() => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ findPty: vi.fn(() => ({ id: 'pty-7' })) as never, write: write as never, sendCoordMessage: sendCoordMessage as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    expect(sendCoordMessage).not.toHaveBeenCalled();
  });

  it('session ended, not resumable, presence gone → DEGRADES to a coord inbox notification, not a drop (P-001)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ sessionId: null, ompThreadId: null }), payload: null }),
      deps({
        getSession: vi.fn(async () =>
          session({ endedAt: new Date().toISOString(), pid: null, sessionId: null, ompThreadId: null }),
        ) as never,
        presence: vi.fn(async () => stalePresence) as never,
        sendCoordMessage: sendCoordMessage as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    expect(sendCoordMessage).toHaveBeenCalledTimes(1);
  });

  it('no handle BUT a live psu-host socket → inject via the socket, not park (EI-152)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledWith('/tmp/x.sock', expect.objectContaining({ mode: 'turn' }));
  });

  it('threads this delivery\'s own id onto the envelope as deliveryId (EI-19311270129974785 — host-side retry dedup)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    await executeWake(
      work({ wakeHandle: null, id: 35092 }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: injectPsuHost as never }),
    );
    expect(injectPsuHost).toHaveBeenCalledWith('/tmp/x.sock', expect.objectContaining({ deliveryId: '35092' }));
  });

  it('no handle + live socket but inject FAILS → falls through to park (live presence)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: vi.fn(async () => false) as never }),
    );
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('plan-run handle → resumed via the plans:resume path', async () => {
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const out = await executeWake(
      work({ wakeHandle: { kind: 'plan-run', runId: 12 } }),
      deps({ resumePlanRun }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(resumePlanRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 12 }));
    const planArg = (resumePlanRun.mock.calls[0] as unknown as [{ wakeText: string }])[0];
    expect(planArg.wakeText).toContain('lock:grant:t-1');
  });

  it('alive + managed pty pid-match → inject the turn TEXT now, the submit CR as a SEPARATE keystroke', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const forceResume = vi.fn(async () => true);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({
          findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
          write: write as never,
          isLoopArmed: vi.fn(async () => true),
          forceResume,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
      expect(forceResume).not.toHaveBeenCalled();
      // First write = the turn TEXT, with NO trailing CR. A one-shot text+CR burst
      // is swallowed by the claude TUI's paste detector (CR → literal newline), so
      // the CR must arrive as its own keystroke.
      const [id, buf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(id).toBe('pty-7');
      expect(buf.toString()).toContain('lock:grant:t-1');
      expect(buf.toString()).not.toMatch(/\r$/);
      expect(write).toHaveBeenCalledTimes(1);
      // The submit CR lands as a SEPARATE write after the settle delay.
      await vi.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('alive in a terminal we do not own → park (never inject keystrokes elsewhere)', async () => {
    const out = await executeWake(work({ wakeHandle: advHandle() }), deps());
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('alive');
  });

  it('WI-666: active resumable loop owner gets bounded force-resume, then the normal headless resume', async () => {
    const forceResume = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        isLoopArmed: vi.fn(async () => true),
        forceResume,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(forceResume).toHaveBeenCalledWith(9999);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('WI-666: force-resume timeout keeps the alive loop owner safely parked', async () => {
    const forceResume = vi.fn(async () => false);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        isLoopArmed: vi.fn(async () => true),
        forceResume,
        spawnDetached,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('bounded force-resume');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('live psu-pty host → inject the wake turn into its control socket (channel psu-socket-inject)', async () => {
    // turn-lifecycle-control Phase 3 P-014: a live interactive psu session the
    // operator can't see via findPty (its pty is in the psu process) is woken in
    // place via its discovered control socket — NOT parked, NOT a concurrent resume.
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/su-abc.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        // even if findPty would match, the psu host is checked FIRST (it's the
        // authoritative live-injectable signal).
        findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [sock, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(sock).toBe('/tmp/psu-pty/su-abc.sock');
    expect(msg.mode).toBe('turn');
    expect(msg.data).toContain('lock:grant:t-1');
  });

  it('psu host present but the socket inject FAILS → falls through to the normal channels (park)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/dead.sock' })) as never,
        injectPsuHost: vi.fn(async () => false) as never, // socket died mid-attempt
      }),
    );
    // findPty defaults to null + alive → "alive but not an injectable managed pty" park.
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('re-verifies the owner host after a socket miss and retries a rebound socket', async () => {
    const findPsuHost = vi
      .fn()
      .mockReturnValueOnce({ sock: '/tmp/psu-pty/stale.sock' })
      .mockReturnValueOnce({ sock: '/tmp/psu-pty/rebound.sock' });
    const injectPsuHost = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: findPsuHost as never,
        injectPsuHost: injectPsuHost as never,
      }),
    );

    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(findPsuHost).toHaveBeenCalledTimes(2);
    expect(injectPsuHost).toHaveBeenNthCalledWith(1, '/tmp/psu-pty/stale.sock', expect.objectContaining({ mode: 'turn' }));
    expect(injectPsuHost).toHaveBeenNthCalledWith(2, '/tmp/psu-pty/rebound.sock', expect.objectContaining({ mode: 'turn' }));
  });

  it('exited claude with a native id → DETACHED headless `-p` turn (never a pty — a TTY stdin makes `-p` hang)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnManagedPty = vi.fn(() => ({ id: 'pty-new' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), spawnDetached, spawnManagedPty: spawnManagedPty as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    // claude resume runs detached, NOT in the pty (the Stage-B hang fix).
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('claude');
    expect(args).toContain('--resume');
    expect(args).toContain('-p'); // headless one-turn
    expect(o.cwd).toBe('/repo');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
    // WI-3082: a resume IS a coord/events:await-wake-triggered fresh spawn —
    // stamp the turn-trigger so agent_usage_samples.turn_trigger isn't NULL for
    // every persistent-agent (queen/overwatch/doc-steward) resume.
    expect(o.env.PAPERCUSP_TURN_TRIGGER).toBe('coord-wake');
  });

  it('uses the persisted adv-session scope when the event delivery is pinned to the flat coord workspace', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ workspaceId: 'default', wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' })) as never,
        alive: vi.fn(() => false),
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(o.env.PAPERCUSP_WORKSPACE).toBe('papercusp-workspace');
    expect(o.env.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
  });

  it('exited codex → DETACHED `exec resume <uuid>` with CODEX_HOME, uuid recovered from the rollout (P-009)', async () => {
    let onExit:
      | ((exit: { exitCode: number | null; signal: string | null; stdoutTail: string; stderrTail: string }) => void)
      | undefined;
    let observedExit: unknown;
    const spawnDetached = vi.fn((_bin, _args, _options, exitHandler) => {
      onExit = exitHandler;
      return 5555;
    });
    const delivery = work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null }) });
    const out = await executeWake(
      // codex carries no native id on the row — executeWake recovers it from the home.
      delivery,
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null })) as never,
        spawnDetached,
        onResumeTurnExit: (_d, exit) => {
          observedExit = exit;
        },
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('codex');
    expect(args.slice(0, 5)).toEqual([
      'exec', '--json', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume',
    ]);
    expect(args[5]).toBe(ROLLOUT_UUID); // recovered from the newest rollout
    expect(args[6]).toContain('lock:grant:t-1'); // the wake turn text
    expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
    expect(onExit).toBeTypeOf('function');
    onExit!({
      exitCode: 0,
      signal: null,
      stdoutTail: '{"type":"turn.completed","usage":{}}',
      stderrTail: '',
    });
    expect(observedExit).toEqual({
      exitCode: 0,
      signal: null,
      stdoutTail: '{"type":"turn.completed","usage":{}}',
      stderrTail: '',
      outputProtocol: 'codex-jsonl',
    });
  });

  it('exited codex with NO recoverable home → park, never a bare --last (P-009)', async () => {
    const out = await executeWake(
      // adv-session 999 has no codex home on disk → no uuid → not resumable.
      work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null, advSessionId: 999 }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, id: 999 })) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('a session row marked ended is exited even if the recorded pid is reused-alive', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ endedAt: new Date().toISOString() })) as never,
        alive: vi.fn(() => true), // pid reused by some other process
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('exited claude WITHOUT a native id + live presence → park, never --continue', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ sessionId: null }) }),
      deps({
        getSession: vi.fn(async () => session({ sessionId: null })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
  });

  it('exited omp → detached headless one-turn resume with prompt (no PTY)', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const spawnManagedPty = vi.fn(() => fakeOmpPty());
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('omp');
    expect(args.slice(0, 4)).toEqual(['-r', 'th-1', '--approval-mode', 'yolo']);
    expect(args).toContain('-p');
    expect(args[args.length - 1]).toContain('lock:grant:t-1');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
    // Regression: the autonomous resume turn MUST carry the bee's workspace so
    // omp's user-level MCP (x-papercusp-workspace from `${PAPERCUSP_WORKSPACE:-}`)
    // resolves a concrete workspace. Without it the clamp rejects the session
    // and EVERY coord:* tool 404s ("Tool coord:orient not found").
    expect(o.env.PAPERCUSP_WORKSPACE).toBe('ws');
  });

  it('exited omp PTY fallback → readiness-gated prompt injection into the new pty', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const spawnManagedPty = vi.fn(() => pty);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: spawnManagedPty as never,
          write: write as never,
        }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).not.toHaveBeenCalled();
      for (const cb of pty.onData) cb(Buffer.from('OMP ready\n> '));
      // Audit P-034: the prompt must land as TWO writes — text, then the submit
      // CR as a separate keystroke after a settle. The old single text+CR buffer
      // tripped the TUI paste detector (CR → literal newline, turn never submits).
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(1);
      const [ptyId, textBuf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(ptyId).toBe('pty-omp');
      expect(textBuf.toString()).not.toMatch(/\r$/);
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
      await expect(pending).resolves.toEqual({ kind: 'delivered', channel: 'resume' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('exited omp PTY fallback readiness timeout → error with transcript tail and pty cleanup', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const kill = vi.fn(() => true);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: vi.fn(() => pty) as never,
          write: write as never,
          kill: kill as never,
        }),
      );
      for (const cb of pty.onData) cb(Buffer.from('loading account router'));
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(pending).resolves.toMatchObject({
        kind: 'error',
        error: expect.stringContaining('did not become ready'),
      });
      expect(write).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith('pty-omp');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp prompt helper accepts a quiet settled screen and captures transcript tail', async () => {
    const write = vi.fn(() => true);
    const pty = fakeOmpPty('pty-helper');
    const pending = injectOmpWakeTurnWhenReady({
      pty,
      wakeText: 'WAKE',
      write: write as never,
      readyTimeoutMs: 1_000,
      quietReadyMs: 100,
      submitCrDelayMs: 25,
    });
    for (const cb of pty.onData) cb(Buffer.from('restored thread th-1\n'));
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledWith('pty-helper', Buffer.from('WAKE', 'utf8'));
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ ok: true, transcriptTail: 'restored thread th-1\n' });
    expect(write).toHaveBeenLastCalledWith('pty-helper', Buffer.from('\r', 'utf8'));
  });

  it('NO recorded pid + fresh presence → park (never concurrent-resume a live session)', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        spawnManagedPty: spawnManagedPty as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
  });

  it('NO recorded pid + stale presence → resume (the session is gone)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        presence: vi.fn(async () => stalePresence) as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('claude resume spawn failure (detached returns no pid) → error outcome (the pump retries with backoff)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        spawnDetached: vi.fn(() => null) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'error' });
  });
});

describe('GAP 3: wake resume env-assembly matrix (wake-executor.ts:441-474)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claude resume with a coord owner + on-disk config dir → CLAUDE_CONFIG_DIR + MCP_TIMEOUT + PAPERCUSP_AGENT_SESSION + fleet token', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-claude-cfg-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-claude-token-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'claude-token');
    try {
      // The persistent per-session config dir the resume leg remounts (D-010).
      mkdirSync(pjoin(claudeRoot, 'su-owner-9'), { recursive: true });
      // A minted fleet setup-token so CLAUDE_CODE_OAUTH_TOKEN is exported (P-003).
      writeFileSync(pjoin(tokenDir, 'claude-token'), 'sk-ant-oat01-test-token\n');

      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({
          alive: vi.fn(() => false), // exited → resume
          getSession: vi.fn(async () => session({ agent: 'claude', coordOwnerId: 'su-owner-9' })) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      // Base wake env (always present on a resume).
      expect(o.env.PAPERCUSP_SID).toBe('su-abc');
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
      expect(o.env.PAPERCUSP_WAKE_DELIVERY_ID).toBe('7');
      // claude-specific: config-dir remount + fleet token.
      expect(o.env.CLAUDE_CONFIG_DIR).toBe(pjoin(claudeRoot, 'su-owner-9'));
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
      // No codex home leaks onto a claude resume.
      expect(o.env.CODEX_HOME).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('codex resume → CODEX_HOME present, but CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN ABSENT (no claude env leaks)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    // Point the claude config root + token at tmp roots WITHOUT provisioning this
    // owner's subdir/token — so even though coordOwnerId is set, neither claude
    // env is applied (the fleet token is claude-only; CLAUDE_CONFIG_DIR needs the
    // dir on disk). Hermetic: never reads the real ~/.papercusp.
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-codex-noclaude-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-codex-notoken-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'absent-token');
    // A claude token exists on disk — proving codex STILL doesn't pick it up.
    writeFileSync(pjoin(tokenDir, 'absent-token'), 'sk-ant-oat01-should-not-be-used\n');
    try {
      const spawnDetached = vi.fn(() => 5555);
      const out = await executeWake(
        // adv-session 42 has a codex home on disk (the suite fixture) → uuid recovered.
        work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
        deps({
          alive: vi.fn(() => false),
          // coordOwnerId set to prove it does NOT pull a claude config dir for codex.
          getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, coordOwnerId: 'su-owner-9' })) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [bin, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(bin).toBe('codex');
      // codex-specific: its per-session home is exported.
      expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
      // The claude-only env is NOT applied to a codex resume (the fleet token is a
      // claude-OAuth concept, keyed off `resumeAgent==='claude'`; CLAUDE_CONFIG_DIR
      // needs the owner's dir on disk, which we deliberately did NOT create).
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(o.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      // Base wake env still present.
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });
});

describe('hive Queen fresh-per-wake cutover (queen-brief-cache-assembly B-01 / P-012)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hiveSession = (over: Record<string, unknown> = {}) =>
    session({ label: 'pot · papercup/queen', ...over });

  it('exited hive operator → FRESH hive launch (never claude --resume), carrying the wake text as kickoff', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false), // turn ended → would otherwise resume
        fireHiveWake,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'hive-fresh-wake' });
    // The Queen is fresh-launched, NEVER resumed.
    expect(spawnDetached).not.toHaveBeenCalled();
    const arg = (fireHiveWake.mock.calls[0] as unknown as [{ installSlug: string; kickoff: string }])[0];
    expect(arg.installSlug).toBe('papercup');
    expect(arg.kickoff).toContain('lock:grant:t-1'); // the wake turn text
  });

  it('hive operator + fresh-wake fire FAILS → park, NEVER a --resume fallback (the no-resume invariant is absolute)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false),
        fireHiveWake: vi.fn(async () => false) as never, // fire failed
        spawnDetached,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('never resumed');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('LIVE hive operator (mid-turn, not an injectable pty) → park, no concurrent fresh launch', async () => {
    // Reached BEFORE the resume/fresh-wake branch (the isAlive guard), so a live
    // Queen is never double-launched.
    const fireHiveWake = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ getSession: vi.fn(async () => hiveSession()) as never, alive: vi.fn(() => true), fireHiveWake }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(fireHiveWake).not.toHaveBeenCalled();
  });

  it('a NON-hive ended session (no hive label) still resumes — the cutover is scoped to hive operators only', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), fireHiveWake, spawnDetached }), // session() label is null
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(fireHiveWake).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalled();
  });
});

describe('hiveInstallSlugFromLabel', () => {
  it('parses the install slug from a pot-operator adv_sessions label', () => {
    expect(hiveInstallSlugFromLabel('pot · papercup/queen')).toBe('papercup');
    expect(hiveInstallSlugFromLabel('pot · my-hive/operator')).toBe('my-hive');
  });
  it('returns null for a non-pot label (so non-pot sessions resume as before)', () => {
    expect(hiveInstallSlugFromLabel(null)).toBeNull();
    expect(hiveInstallSlugFromLabel('')).toBeNull();
    expect(hiveInstallSlugFromLabel('bee · papercup/worker')).toBeNull();
    expect(hiveInstallSlugFromLabel('hive · papercup/queen')).toBeNull(); // WI-3967: stale prefix, no longer matches
    expect(hiveInstallSlugFromLabel('pot · ')).toBeNull(); // no slug
  });
});

describe('codex home + rollout recovery (P-009/P-010)', () => {
  it('codexHomeForAdvSession keys the home by the adv-session id', () => {
    expect(codexHomeForAdvSession(42)).toBe(join(CODEX_HOMES_DIR, 'session-42'));
  });

  it('findCodexRolloutSessionId returns the NEWEST rollout uuid; null when absent', () => {
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-42'))).toBe(ROLLOUT_UUID);
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-nope'))).toBeNull();
  });

  it('falls back to history.jsonl when Codex 0.144+ removed the rollout file', () => {
    const home = join(CODEX_HOMES_DIR, 'session-43');
    mkdirSync(home, { recursive: true });
    const historyId = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';
    writeFileSync(
      join(home, 'history.jsonl'),
      [
        JSON.stringify({ session_id: '00000000-0000-0000-0000-000000000000', text: 'old' }),
        '{bounded-tail-can-start-mid-line',
        JSON.stringify({ session_id: historyId, text: 'current' }),
        '',
      ].join('\n'),
    );

    expect(findCodexRolloutSessionId(home)).toBe(historyId);
  });
});

describe('executeWake — turn-provenance tagging (turn-provenance-owner-vs-agent-2026-07-11 P-002)', () => {
  // A spy tagger with the REAL TaggedTurn shape — marks the text so each
  // delivery channel's assertion can see exactly what was tagged, and captures
  // {sid, origin} so the origin-derivation rule is verifiable.
  function spyTagger() {
    const calls: { sid: string; origin: string; text: string }[] = [];
    const tag = ((args: { sid: string; origin: string; text: string }) => {
      calls.push(args);
      return {
        taggedText: `⟦tagged:${args.origin}⟧\n${args.text}`,
        envelope: `⟦tagged:${args.origin}⟧`,
        nonce: 'spy',
        origin: args.origin,
        ledgerWritten: true,
      };
    }) as never;
    return { calls, tag };
  }

  it('warm psu-socket inject delivers TAGGED text (origin wake-pump, sid = subscriber)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:wake-pump⟧\n\[await-event\]/);
    expect(calls).toEqual([expect.objectContaining({ sid: 'su-abc', origin: 'wake-pump' })]);
  });

  it('a loop wake (cold-loop marker on the payload) tags origin loop-fire — even on the warm path', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'warm', wakeCount: 3, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(calls[0]).toMatchObject({ origin: 'loop-fire' });
  });

  it('an owner-Inbox-reply wake (inboxOwnerReply marker on the payload) tags origin coord-inject:owner (owner-inbox-single-pane-2026-07-17 D-006)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { inboxOwnerReply: true } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(calls[0]).toMatchObject({ origin: 'coord-inject:owner' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:coord-inject:owner⟧\n/);
  });

  /**
   * EI-20130618357432548 — SECURITY RAIL, not a cosmetic assertion.
   *
   * An owner CHAT-PANE turn is the same authority as an owner INBOX reply, so it
   * mints the same existing origin. What matters is that it is still ENROLLED at
   * all: delivering it unenveloped would classify it OWNER (interactive), and the
   * UserPromptSubmit provenance hook auto-registers an AUTO/DRAIN mode grant on
   * that branch and only that branch. `/api/admin/coord/send` admits a no-Origin
   * loopback POST, so an unenrolled delivery would let any agent with a shell curl
   * an owner-stamped directive — and a mode grant — into a peer's session. If this
   * test is ever changed to expect no tag, that hole is what is being opened.
   */
  it('an owner CHAT-PANE wake is still ENROLLED, tagged coord-inject:owner — never delivered unenveloped', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { calls, tag } = spyTagger();
    const out = await executeWake(
      work({
        wakeHandle: advHandle(),
        payload: { msg_id: 'm1', ownerChatTurn: true, ownerChatText: 'hi' },
      }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(calls[0]).toMatchObject({ origin: 'coord-inject:owner' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦tagged:coord-inject:owner⟧\n/);
    // The owner's own words are what follows the tag — not a wake wrapper.
    expect(msg.data).toContain('\nhi\n\n⟦owner-chat⟧');
  });

  it('the COLD injection is tagged too (origin loop-fire wraps renderColdWakeInjection)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const { tag } = spyTagger();
    await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume'),
        tagTurn: tag,
      }),
    );
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(msg.mode).toBe('reset');
    expect(msg.data).toMatch(/^⟦tagged:loop-fire⟧\n/);
    expect(msg.data).toContain('## Next action\nresume');
  });

  it('the degrade-to-inbox body is NEVER tagged (coord messages carry native provenance)', async () => {
    const sendCoordMessage = vi.fn(async () => ({}) as never);
    const { tag } = spyTagger();
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({
        findPsuHost: vi.fn(() => null) as never,
        presence: vi.fn(async () => ({ ...livePresence, stale: true })) as never,
        sendCoordMessage: sendCoordMessage as never,
        tagTurn: tag,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'inbox' });
    const [, msg] = sendCoordMessage.mock.calls[0] as unknown as [unknown, { body: string }];
    expect(msg.body).not.toContain('⟦tagged:');
    expect(msg.body).toContain('[await-event]');
  });

  it('a tagger that throws never breaks the wake — an unverified envelope still delivers', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/x.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        tagTurn: (() => {
          throw new Error('ledger disk full');
        }) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { data: string }];
    expect(msg.data).toMatch(/^⟦turn-origin:wake-pump nonce:[a-f0-9]{16}⟧\n\[await-event\]/);
  });
});

describe('executeWake — psu-host cold-auto fork (su-cold-auto-mode-2026-07-03 Phase 2)', () => {
  // A cold loop-wake payload marker (loop-fire stamps carry/wakeCount/harness).
  const coldPayload = (over: Record<string, unknown> = {}) => ({
    carry: 'cold',
    wakeCount: 1,
    harness: 'papercusp',
    ...over,
  });

  // deps with a LIVE psu-host socket + the cold fork wired ON (master gate true,
  // a carry-note present). Individual cases override to exercise each gate.
  const coldDeps = (over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps =>
    deps({
      findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/cold.sock' })) as never,
      injectPsuHost: vi.fn(async () => true) as never,
      coldAutoEnabled: vi.fn(async () => true),
      getLoopCarryNoteFn: vi.fn(async () => '## Next action\nresume the wiring'),
      ...over,
    });

  it('cold-armed + enabled + carry-note → RESET-CONTEXT inject (channel psu-socket-reset, data = the carry-note WRAPPED with the re-checkpoint mandate, not the warm turn)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    const [sock, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(sock).toBe('/tmp/psu-pty/cold.sock');
    expect(msg.mode).toBe('reset');
    // P-002 producer: the injected text is the carry-note wrapped by renderColdWakeInjection —
    // it carries the note verbatim AND the standing "refresh via loop:checkpoint" mandate so the
    // cold anchor stays fresh across wakes. EI-15799: the payload's fire-time wakeCount (1 here)
    // is threaded through as the staleness marker, so the expectation must carry it too.
    expect(msg.data).toBe(renderColdWakeInjection('## Next action\nresume the wiring', undefined, 1));
    expect(msg.data).toContain('## Next action\nresume the wiring');
    expect(msg.data).toContain('loop:checkpoint');
  });

  it('EI-18224278118395857: the production read (meta variant, no getLoopCarryNoteFn seam) threads the note write-time into the injection so a late-flushed stale note is self-evident', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const updatedAtMs = Date.parse('2026-07-21T03:10:00.000Z');
    const getLoopCarryNoteWithMetaFn = vi.fn(async () => ({
      note: '## Next action\nresume the wiring',
      updatedAtMs,
    }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 96 }) }),
      coldDeps({
        injectPsuHost: injectPsuHost as never,
        // Drop the note-only seam so the production META read runs (carries updatedAtMs).
        getLoopCarryNoteFn: undefined,
        getLoopCarryNoteWithMetaFn: getLoopCarryNoteWithMetaFn as never,
      }),
    );
    // fire #96 is 96 % 8 === 0 ⇒ a RECYCLE (faithful to the reported incident); the injected
    // data is composed by renderColdWakeInjection for both reset and recycle.
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    expect(getLoopCarryNoteWithMetaFn).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-abc',
      workspaceId: 'ws',
    });
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    // the fresh-read note is still the core, now with the write-time stamp + reconcile guidance.
    expect(data).toContain('## Next action\nresume the wiring');
    expect(data).toContain('[07-21T03:10:00Z]');
    expect(data.toLowerCase()).toContain('stale');
    expect(data.toLowerCase()).toContain('reconcile');
    expect(data).toContain('(fire #96)');
  });

  // WI-6951: the un-checkpointed-work banner must read the STRICT turn signal
  // (lastRealTurnAt = session_turn_journal) and never the lastTurnAt union, which folds
  // in the '■ session ended' lifecycle marker. A cold reset KILLS its predecessor, so that
  // marker always postdates the final loop:checkpoint — feeding it to this check reported a
  // session death as "you completed a turn at …". These three cases are the live incident
  // (su-7854d874 fire #12), its true-positive twin, and the no-fallback rule.
  describe('WI-6951 — un-checkpointed-work banner sources the strict turn signal', () => {
    const noteAtMs = Date.parse('2026-08-02T05:29:48.175Z');
    const realTurnIso = '2026-08-02T05:30:24.495Z'; // 36s after the note — INSIDE the 5-min floor
    const sessionEndIso = '2026-08-02T06:00:23.817Z'; // predecessor killed, ~31m after the note
    const BANNER = 'UN-CHECKPOINTED WORK EXISTS';

    const coldDataWithStatus = async (status: Record<string, unknown> | null) => {
      const injectPsuHost = vi.fn(async () => true);
      await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 12 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          getLoopCarryNoteFn: undefined,
          getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
            note: '## Next action\nresume the wiring',
            updatedAtMs: noteAtMs,
          })) as never,
          getLoopStatusFn: vi.fn(async () => status) as never,
        }),
      );
      return (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    };

    it('does NOT fire when only the session-END marker postdates the note (the live false alarm)', async () => {
      const data = await coldDataWithStatus({
        lastTurnAt: sessionEndIso, // the union — a session DEATH, ~31m after the note
        lastRealTurnAt: realTurnIso, // the truth — a turn 36s after the note
      });
      expect(data).not.toContain(BANNER);
      // and specifically never quotes the kill instant back as a completed turn
      expect(data).not.toContain('06:00:23');
      expect(data).toContain('## Next action\nresume the wiring');
    });

    it('STILL fires when a real turn genuinely postdates the note (the true positive is preserved)', async () => {
      const data = await coldDataWithStatus({
        lastTurnAt: sessionEndIso,
        lastRealTurnAt: sessionEndIso, // a genuine journal turn that late
      });
      expect(data).toContain(BANNER);
      expect(data).toContain('06:00:23');
    });

    it('does NOT fall back to lastTurnAt when the strict signal is absent — silence beats a false alarm', async () => {
      const data = await coldDataWithStatus({ lastTurnAt: sessionEndIso, lastRealTurnAt: null });
      expect(data).not.toContain(BANNER);
    });
  });

  // EI-19984789589075138: `lastRealTurnAt` is a well-formed turn even when it is a usage-wall /
  // withheld-fire bounce that made zero tool calls — so the WI-6951 strict signal alone still
  // fires the banner on that shape. This is the follow-up evidence check.
  describe('EI-19984789589075138 — evidence check downgrades a bounced-fire false alarm', () => {
    const noteAtMs = Date.parse('2026-08-09T13:51:00.000Z');
    const realTurnIso = '2026-08-09T14:06:00.000Z'; // ~15m after the note — clears the floor
    const BANNER = 'UN-CHECKPOINTED WORK EXISTS';

    const coldRun = async (status: Record<string, unknown> | null, countAgentToolCallsFn?: unknown) => {
      const injectPsuHost = vi.fn(async () => true);
      await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 6 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          getLoopCarryNoteFn: undefined,
          getLoopCarryNoteWithMetaFn: vi.fn(async () => ({
            note: '## Next action\nresume the wiring',
            updatedAtMs: noteAtMs,
          })) as never,
          getLoopStatusFn: vi.fn(async () => status) as never,
          ...(countAgentToolCallsFn ? { countAgentToolCallsFn: countAgentToolCallsFn as never } : {}),
        }),
      );
      return (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    };

    it('downgrades to the bounced-fire notice when the evidence check confirms zero agent tool calls', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 0);
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso }, countAgentToolCallsFn);
      expect(countAgentToolCallsFn).toHaveBeenCalledWith('su-abc', noteAtMs, Date.parse(realTurnIso));
      expect(data).not.toContain(BANNER);
      expect(data).toContain('bounced fire');
    });

    it('keeps the strong banner when the evidence check finds real tool calls', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 5);
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso }, countAgentToolCallsFn);
      expect(data).toContain(BANNER);
      expect(data).not.toContain('bounced fire');
    });

    it('keeps the strong (existing) banner unchanged when the evidence check is never wired (defaults preserved)', async () => {
      const data = await coldRun({ lastTurnAt: realTurnIso, lastRealTurnAt: realTurnIso });
      expect(data).toContain(BANNER);
    });

    it('never calls the evidence check at all when the banner would not fire anyway (inside the floor)', async () => {
      const countAgentToolCallsFn = vi.fn(async () => 0);
      const closeIso = '2026-08-09T13:51:30.000Z'; // 30s after the note — inside the 5min floor
      const data = await coldRun({ lastTurnAt: closeIso, lastRealTurnAt: closeIso }, countAgentToolCallsFn);
      expect(countAgentToolCallsFn).not.toHaveBeenCalled();
      expect(data).not.toContain(BANNER);
    });
  });

  // WI-6862: the booked channel must say WHICH signal produced the `true`. injectIntoHost's
  // bare boolean resolves true on a BARE SOCKET CLOSE, which is exactly what a host killed
  // mid-delivery (a provider usage_limit wall hitting the respawn) looks like — so a cold
  // reset that never re-execed was booked as an unqualified success and read back that way
  // by whoever was diagnosing it (observed on WI-6852: booked delivered 02:58:02.883Z, the
  // respawn hit the wall at 02:58:07.310Z).
  describe('WI-6862 — the cold channel distinguishes an ACKED re-exec from an ASSUMED one', () => {
    const confirming = (r: { ok: boolean; confirmation: string }) =>
      ({ injectPsuHostWithConfirmation: vi.fn(async () => r) }) as unknown as Partial<ExecuteWakeDeps>;

    it("books 'psu-socket-reset' when the HOST acked — the only value that means it confirmed", async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'acked' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    });

    it("books 'psu-socket-reset-unconfirmed' on a bare close — the wall-killed respawn that used to read as a clean success", async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'assumed-close' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset-unconfirmed' });
    });

    it('the RECYCLE cadence (wakeCount % 8 === 0) carries the same distinction, both ways', async () => {
      const acked = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'acked' })),
      );
      expect(acked).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
      const assumed = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
        coldDeps(confirming({ ok: true, confirmation: 'assumed-close' })),
      );
      expect(assumed).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle-unconfirmed' });
    });

    it('a NOT-ok confirmation is not a channel at all — it still falls through to the warm inject', async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(confirming({ ok: false, confirmation: 'timeout' })),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    });

    // THE CONTROL. Without it the three assertions above would also pass if the fixture
    // never reached the confirmation seam at all: `coldDeps` supplies an `injectPsuHost`
    // stub, and a stub has no confirmation channel, so resolution deliberately falls back
    // to today's exact boolean behavior. This case pins that fallback — proving the
    // channels above are produced by the confirmation value and not by the fixture shape.
    it('CONTROL: an injectPsuHost stub with no confirmation seam keeps TODAY’s channel unchanged', async () => {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps(),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    });
  });

  it('P-003 (compaction-continuity-hardening): the cold injection appends the carry-brief EXTRAS (held items + walls/facts + awaits + fleet) after the note; the note stays the core', async () => {
    const injectPsuHost = vi.fn(async () => true);
    // The return is TYPED as CarryBrief on purpose: this fixture has now been
    // bitten TWICE by contract drift (EI-8593: missing `walls`; then EI-11484:
    // missing `directives`) — each time the renderer threw on the absent field,
    // the note-only catch swallowed it, and the extras were silently dropped.
    // With the explicit type, the NEXT CarryBrief field addition fails tsc HERE
    // instead of failing this assertion at runtime.
    const buildCarryBriefFn = vi.fn(async (ownerId: string): Promise<CarryBrief> => ({
      ownerId,
      loop: null,
      heldItems: [
        { id: 'WI-3319', title: 'Shared carry-brief builder', body: null, harness: 'papercusp', checkpoint: 'watchdog wired; cold anchor next' },
      ],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [{ key: 'zombie-pids-wall', body: '3 PIDs await owner OK' }],
      awaits: [{ eventKey: 'deploy:done:release-77', note: null }],
      fleet: { slug: 'bug-drain', role: 'leader' },
    }));
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never, buildCarryBriefFn: buildCarryBriefFn as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(buildCarryBriefFn).toHaveBeenCalledWith('su-abc', { workspaceId: 'ws' });
    const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
    // The note leads, the extras follow, the re-checkpoint mandate closes.
    expect(data).toContain('## Next action\nresume the wiring');
    expect(data).toContain('WI-3319 — Shared carry-brief builder');
    expect(data).toContain('checkpoint: watchdog wired; cold anchor next');
    expect(data).toContain('zombie-pids-wall: 3 PIDs await owner OK');
    expect(data).toContain('deploy:done:release-77');
    expect(data).toContain('Fleet: you are in "bug-drain" as leader');
    expect(data.indexOf('resume the wiring')).toBeLessThan(data.indexOf('WI-3319'));
    expect(data.indexOf('WI-3319')).toBeLessThan(data.indexOf('Before you END this turn'));
  });

  it('P-003 fail-soft: a THROWING carry-brief reader injects the note alone (byte-identical to the extras-less injection) AND warns — the swallow must never be silent', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await executeWake(
        work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 1 }) }),
        coldDeps({
          injectPsuHost: injectPsuHost as never,
          buildCarryBriefFn: vi.fn(async () => {
            throw new Error('pg down');
          }) as never,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
      const data = (injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data;
      // EI-15799: byte-identical to the extras-less injection AT THE SAME fire number (1).
      expect(data).toBe(renderColdWakeInjection('## Next action\nresume the wiring', undefined, 1));
      // Detector guard (EI-8593 / EI-11484 class): a dropped extras leg means a cold
      // wake silently loses held-items/walls/facts continuity — it must at least log.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cold carry-brief extras failed'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('the HYBRID cadence recycles every Nth wake (wakeCount 8 → RECYCLE, channel psu-socket-recycle)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload({ wakeCount: 8 }) }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('recycle');
  });

  it('the handle-less always-armed branch forks cold too (both inject sites wired, not just the main one)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null, payload: coldPayload() }),
      coldDeps(),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
  });

  it('DORMANT by default: a cold-armed wake with cold-auto DISABLED (no gate dep) stays WARM (mode turn) and never reads the carry-note', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      // NO coldAutoEnabled → defaults to ()=>false ⇒ the whole fork is inert.
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/cold.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        getLoopCarryNoteFn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('P-006 guard: cold + enabled but NO carry-note anchor → stays WARM (never cold-start with nothing to rebuild from)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({ getLoopCarryNoteFn: vi.fn(async () => null) as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });

  it('a cold marker with NO harness scope → WARM, short-circuited before the flag read', async () => {
    const coldAutoEnabled = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1 } }),
      coldDeps({ coldAutoEnabled }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(coldAutoEnabled).not.toHaveBeenCalled();
  });

  it('a WARM loop wake (carry!=="cold") never touches the cold path — gate + note untouched', async () => {
    const coldAutoEnabled = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'warm', wakeCount: 3, harness: 'papercusp' } }),
      coldDeps({ coldAutoEnabled, getLoopCarryNoteFn }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(coldAutoEnabled).not.toHaveBeenCalled();
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a COLD inject that misses falls back to a WARM inject in place (never drops the wake)', async () => {
    let call = 0;
    const injectPsuHost = vi.fn(async () => call++ !== 0); // 1st (cold reset) misses, 2nd (warm) lands
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({ injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledTimes(2);
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('reset');
    expect((injectPsuHost.mock.calls[1] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
  });

  it('FAIL-SOFT: a carry-note read that THROWS falls back to WARM (a cold-path fault never drops a wake)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: coldPayload() }),
      coldDeps({
        getLoopCarryNoteFn: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });
});

describe('executeWake — P-021 verdict-gated cold-by-default (deterministic-context-carry, WI-5000)', () => {
  // The NO-carry loop marker a WARM loop's fire now stamps ({wakeCount, harness}).
  const warmLoopPayload = (over: Record<string, unknown> = {}) => ({
    wakeCount: 1,
    harness: 'papercusp',
    ...over,
  });
  const hostView = { sock: '/tmp/psu-pty/p021.sock', bridgeTty: false, lastInputAt: null };
  const p021Deps = (over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps =>
    deps({
      findPsuHost: vi.fn(() => ({ ...hostView })) as never,
      injectPsuHost: vi.fn(async () => true) as never,
      coldAutoEnabled: vi.fn(async () => true),
      classDefaultCold: vi.fn(async () => true),
      getLoopCarryNoteFn: vi.fn(async () => '## Next action\ncontinue the drain'),
      ...over,
    });

  it('a no-carry loop wake on a drill-proven class colds (RESET) WITHOUT the per-loop opt-in — and the resolver receives the HOST view (bridgeTty/lastInputAt)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ injectPsuHost: injectPsuHost as never, classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }])[1].mode).toBe('reset');
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { data: string }])[1].data).toContain(
      '## Next action\ncontinue the drain',
    );
    expect(classDefaultCold).toHaveBeenCalledWith(expect.objectContaining({ bridgeTty: false, lastInputAt: null }));
  });

  it('the HYBRID recycle cadence applies on the verdict route too (wakeCount 8 → RECYCLE)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload({ wakeCount: 8 }) }),
      p021Deps(),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-recycle' });
  });

  it('DORMANT by default: with NO classDefaultCold dep wired, a no-carry loop wake stays WARM and never reads the carry-note (today’s behavior, byte-identical)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      deps({
        findPsuHost: vi.fn(() => ({ ...hostView })) as never,
        injectPsuHost: injectPsuHost as never,
        coldAutoEnabled: vi.fn(async () => true),
        getLoopCarryNoteFn,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect((injectPsuHost.mock.calls[0] as unknown as [string, { mode: string }])[1].mode).toBe('turn');
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('a FALSE verdict (class unproven / active exchange / flag off) stays WARM without a note read', async () => {
    const getLoopCarryNoteFn = vi.fn(async () => 'note');
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ classDefaultCold: vi.fn(async () => false), getLoopCarryNoteFn }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(getLoopCarryNoteFn).not.toHaveBeenCalled();
  });

  it('the MASTER gate (SU_COLD_AUTO) outranks the verdict: gate off ⇒ the resolver is never consulted', async () => {
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ coldAutoEnabled: vi.fn(async () => false), classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('an explicitly COLD-armed loop never consults the verdict (the opt-in route needs none)', async () => {
    const classDefaultCold = vi.fn(async () => false);
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: { carry: 'cold', wakeCount: 1, harness: 'papercusp' } }),
      p021Deps({ classDefaultCold }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-reset' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('a NON-loop wake (no payload marker) never consults the verdict', async () => {
    const classDefaultCold = vi.fn(async () => true);
    const out = await executeWake(work({ wakeHandle: advHandle() }), p021Deps({ classDefaultCold }));
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(classDefaultCold).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: a THROWING verdict resolver stays WARM — never a dropped wake', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({
        classDefaultCold: vi.fn(async () => {
          throw new Error('ledger unreadable');
        }),
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });

  it('P-006 unchanged on the verdict route: no carry-note anchor ⇒ WARM', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle(), payload: warmLoopPayload() }),
      p021Deps({ getLoopCarryNoteFn: vi.fn(async () => null) as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
  });
});

describe('applyInjectionDoor (deterministic-context-carry P-006 leg (b))', () => {
  it('a wake within the door passes through byte-identical (the common case pays nothing)', () => {
    const text = 'a normal-sized wake';
    expect(applyInjectionDoor(work(), text)).toBe(text);
  });

  it('an over-door wake is truncated with a pointer line, and the FULL text is spilled to the subscriber spill file', () => {
    const d = work({ id: 990_001, subscriberId: 'su-door-test' });
    const text = Array.from({ length: 400 }, (_, i) => `carry-note line ${i} with enough words to overflow the injection budget`).join('\n');
    const out = applyInjectionDoor(d, text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toMatch(/\[injection-door: wake text exceeded/);
    const m = out.match(/the FULL text is at (\S+) —/);
    expect(m).not.toBeNull();
    const spillPath = m![1];
    expect(spillPath).toContain(join('.papercusp', 'wake-spills', 'su-door-test', 'delivery-990001.md'));
    const spilled = readFileSync(spillPath, 'utf8');
    expect(spilled).toContain(text); // the WHOLE original, not just the overflow
    rmSync(spillPath, { force: true });
  });

  it('kill-switch PAPERCUSP_INJECTION_DOOR_OFF=1 bypasses the door entirely', () => {
    const prev = process.env.PAPERCUSP_INJECTION_DOOR_OFF;
    process.env.PAPERCUSP_INJECTION_DOOR_OFF = '1';
    try {
      const text = 'y'.repeat(50_000);
      expect(applyInjectionDoor(work(), text)).toBe(text);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_INJECTION_DOOR_OFF;
      else process.env.PAPERCUSP_INJECTION_DOOR_OFF = prev;
    }
  });
});
