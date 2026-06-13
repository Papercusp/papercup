/**
 * chat:ask_choice handler tests — post bespoke-card-improvements migration.
 * Plan: §4.6 + §4.9.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetCardCorrelatorForTests,
  _resetStateChannelForTests,
  getSnapshot,
  openRun,
  registerCard,
  resolveCardResponse,
} from '@papercusp/agent-mcp';

// B-10: the handler reads two flags via @papercusp/flags/server. Mock getFlag so
// the bee-interception path is deterministic; an unconfigured vi.fn() returns
// undefined (falsy) ⇒ the legacy un-intercepted path, which every pre-existing
// test below depends on.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { configureCoordLog, resetCoordLog } from '../coordination/log';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { listEscalations } from '../coordination/escalations';
import { AGENT_CARD_TIMEOUT_MS } from '../coordination/agent-question-gate';

// Import the tool's handler directly. The tool definition is the default
// export of the module; we exercise the handler with a mock context.
import askChoiceTool from './ask_choice';

const ws = 'workspace-AC';

function makeCtx(askUser: unknown) {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: ws,
    runId: 'r-ac',
    role: 'operator',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    askUser: askUser as any,
  };
}

// The ctx.askUser mocks below are mostly declared with no params, so to TS
// `mock.calls[0]` is the empty tuple `[]` and `[0]` trips TS2493. Read the first
// CardSpec the handler passed through this typed accessor instead of indexing the
// tuple directly (callers narrow it with their own `as {…}`).
function firstSpec(askUser: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return askUser.mock.calls[0][0] as Record<string, unknown>;
}

describe('chat:ask_choice handler', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
  });

  it('returns args_too_large when serialized args exceed cap', async () => {
    const huge = 'x'.repeat(5000);
    const r = await (askChoiceTool as any).handler(
      { question: huge, options: [{ id: 'a', label: 'A' }] },
      makeCtx(vi.fn()),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/args_too_large/);
  });

  it('errors when ctx.askUser is missing (no chat surface)', async () => {
    const r = await (askChoiceTool as any).handler(
      { question: 'q?', options: [{ id: 'a', label: 'A' }] },
      makeCtx(undefined),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/no_chat_surface/);
  });

  it('single-select: blocks until user submits; returns picked option', async () => {
    openRun({ workspaceId: ws, runId: 'r-ac' });

    // Spy on ctx.askUser to drive the deferred resolution.
    const askUser = vi.fn(async (spec) => {
      // The handler will have built a dataSchema; we just resolve.
      return {
        action: 'submit',
        payload: { picks: ['a'] },
      };
    });

    const r = await (askChoiceTool as any).handler(
      {
        question: 'pick one',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      makeCtx(askUser),
    );
    expect(askUser).toHaveBeenCalled();
    const spec = askUser.mock.calls[0][0] as {
      presentation: { kind: string };
      prompt: string;
      fallbackText?: string;
    };
    expect(spec.presentation.kind).toBe('radio');
    expect(spec.fallbackText).toContain('A');
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.picks).toEqual([{ option_id: 'a', label: 'A' }]);
  });

  it('lowercases option ids in the rendered card AND the returned pick', async () => {
    // Migrated from the ask-choice-e2e "echoes lowercased ids" case: under the
    // post-bespoke-card-improvements blocking contract the tool no longer returns
    // a synchronous {rendered, options}, so the normalization (handler L119) is
    // verifiable here — via the CardSpec handed to ctx.askUser and the pick echo.
    openRun({ workspaceId: ws, runId: 'r-ac-lc' });
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['yes'] } }));
    const r = await (askChoiceTool as any).handler(
      { question: 'Test?', options: [{ id: 'Yes', label: 'Yes' }, { id: 'NO', label: 'No' }] },
      makeCtx(askUser),
    );
    const spec = askUser.mock.calls[0][0] as { presentation: { options: Array<{ id: string }> } };
    expect(spec.presentation.options.map((o) => o.id)).toEqual(['yes', 'no']);
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.picks).toEqual([{ option_id: 'yes', label: 'Yes' }]);
  });

  it('multi-select: presentation.kind = checkbox; picks array is preserved', async () => {
    const askUser = vi.fn(async () => ({
      action: 'submit',
      payload: { picks: ['a', 'b'] },
    }));
    const r = await (askChoiceTool as any).handler(
      {
        question: 'pick many',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        multi: true,
      },
      makeCtx(askUser),
    );
    expect((askUser.mock.calls[0][0] as { presentation: { kind: string } }).presentation.kind)
      .toBe('checkbox');
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.picks).toEqual([
      { option_id: 'a', label: 'A' },
      { option_id: 'b', label: 'B' },
    ]);
    expect(parsed.multi).toBe(true);
  });

  it('decline path returns { declined: true, reason }', async () => {
    const askUser = vi.fn(async () => ({
      action: 'decline',
      reason: 'not now',
    }));
    const r = await (askChoiceTool as any).handler(
      {
        question: 'q?',
        options: [{ id: 'a', label: 'A' }],
      },
      makeCtx(askUser),
    );
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.declined).toBe(true);
    expect(parsed.reason).toBe('not now');
  });

  it('cancel path returns { cancelled: true }', async () => {
    const askUser = vi.fn(async () => ({ action: 'cancel' }));
    const r = await (askChoiceTool as any).handler(
      {
        question: 'q?',
        options: [{ id: 'a', label: 'A' }],
      },
      makeCtx(askUser),
    );
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.cancelled).toBe(true);
  });

  it('allowDecline:false propagates into the CardSpec', async () => {
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['a'] } }));
    await (askChoiceTool as any).handler(
      {
        question: 'q?',
        options: [{ id: 'a', label: 'A' }],
        allowDecline: false,
      },
      makeCtx(askUser),
    );
    const spec = askUser.mock.calls[0][0] as { allowDecline?: boolean };
    expect(spec.allowDecline).toBe(false);
  });

  it('voiceAnswerable:true propagates onto radio presentation', async () => {
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['ready'] } }));
    await (askChoiceTool as any).handler(
      {
        question: 'Ready?',
        options: [{ id: 'ready', label: 'Ready' }],
        voiceAnswerable: true,
      },
      makeCtx(askUser),
    );
    const spec = askUser.mock.calls[0][0] as { presentation?: { kind: string; voiceAnswerable?: boolean } };
    expect(spec.presentation?.kind).toBe('radio');
    expect(spec.presentation?.voiceAnswerable).toBe(true);
  });

  it('voiceAnswerable absent → flag is not set on presentation (default false)', async () => {
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['a'] } }));
    await (askChoiceTool as any).handler(
      {
        question: 'q?',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      },
      makeCtx(askUser),
    );
    const spec = askUser.mock.calls[0][0] as { presentation?: { kind: string; voiceAnswerable?: boolean } };
    expect(spec.presentation?.kind).toBe('radio');
    expect(spec.presentation?.voiceAnswerable).toBeUndefined();
  });

  it('voiceAnswerable ignored on multi-select (checkbox presentation)', async () => {
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['a'] } }));
    await (askChoiceTool as any).handler(
      {
        question: 'q?',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        multi: true,
        voiceAnswerable: true,
      },
      makeCtx(askUser),
    );
    const spec = askUser.mock.calls[0][0] as { presentation?: { kind: string; voiceAnswerable?: boolean } };
    expect(spec.presentation?.kind).toBe('checkbox');
    expect((spec.presentation as { voiceAnswerable?: boolean }).voiceAnswerable).toBeUndefined();
  });

  it('end-to-end via real card-correlator: card snapshot is published; resolve unblocks the handler', async () => {
    openRun({ workspaceId: ws, runId: 'r-e2e' });

    // Real ctx.askUser — uses card-correlator + state-channel.
    const askUser = async (spec: import('@papercusp/agent-mcp').CardSpec) => {
      const { result } = registerCard({
        workspaceId: ws,
        runId: 'r-e2e',
        spec,
      });
      return await result;
    };

    // Kick off the handler.
    const promise = (askChoiceTool as any).handler(
      {
        question: 'real e2e',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      { ...makeCtx(askUser), runId: 'r-e2e' },
    );

    // Let the handler register the card.
    await new Promise((r) => setTimeout(r, 5));

    const snap = getSnapshot('r-e2e');
    expect(snap!.snapshot.openCards.length).toBe(1);
    const correlationId = snap!.snapshot.openCards[0].correlationId;

    resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['b'] },
      expectedWorkspaceId: ws,
    });

    const r = await promise;
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.picks).toEqual([{ option_id: 'b', label: 'B' }]);
    // openCards should be empty after resolve.
    expect(getSnapshot('r-e2e')!.snapshot.openCards).toEqual([]);
  });
});

// ── B-10 card interception (queen-autonomous-execution P-041/P-045) ──────────
// A FLEET AGENT's blocking card is intercepted: the spec gets a bounded timeout
// (so the agent never freezes) AND the question is mirrored into a routable
// agent-question escalation. Interactive callers are untouched.
describe('chat:ask_choice — B-10 autonomous-agent card interception', () => {
  // A bee: verified fleet-spawn (uiClientId baked from the signed MCP URL +
  // sigVerifiedSpawn), no superuser/power-user/principal ⇒ resolveAgentIdentity
  // returns source:'fleet-spawn'.
  const beeCtx = (askUser: unknown) => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: ws,
    runId: 'r-bee',
    uiClientId: 'opspawn-bee-1',
    sigVerifiedSpawn: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    askUser: askUser as any,
  });
  // An interactive engineer: resolves to source:'omp-hook-session' (a human is
  // at the card) ⇒ never intercepted.
  const suCtx = (askUser: unknown) => ({
    ...beeCtx(askUser),
    isSuperuser: true,
    sigVerifiedSpawn: false,
  });

  // askUser stand-in that captures the spec, fires onCard (as the real correlator
  // does on registration), and returns the pick.
  const capturingAskUser = (corr: string) =>
    vi.fn(async (spec: { onCard?: (i: { correlationId: string; runId: string; workspaceId: string }) => void }) => {
      spec.onCard?.({ correlationId: corr, runId: 'r-bee', workspaceId: ws });
      return { action: 'submit', payload: { picks: ['a'] } };
    });

  beforeEach(() => {
    configureCoordLog(new InMemoryCoordLog());
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    vi.mocked(getFlag).mockReset();
  });
  afterEach(() => {
    resetCoordLog();
  });

  it('bee + flag ON: spec gets the bounded timeout AND a routable agent-question escalation is written', async () => {
    vi.mocked(getFlag).mockImplementation(async (key: unknown) => key === FLAGS.QUEEN_CARD_INTERCEPTION);
    const askUser = capturingAskUser('corr-bee-1');

    await (askChoiceTool as any).handler(
      { question: 'deploy now?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] },
      beeCtx(askUser),
    );

    const spec = askUser.mock.calls[0][0] as { timeoutMs?: number };
    expect(spec.timeoutMs).toBe(AGENT_CARD_TIMEOUT_MS);

    const escs = await listEscalations();
    expect(escs.length).toBe(1);
    const e = escs[0] as Record<string, unknown>;
    expect(e.category).toBe('agent-question');
    expect(e.autonomous).toBe(true);
    expect(e.rung).toBe('owner-queue');
    expect(e.cardCorrelationId).toBe('corr-bee-1');
    expect(e.cardWorkspaceId).toBe(ws);
  });

  it('interactive superuser + flag ON: NOT intercepted (no timeout, no escalation — a human is watching)', async () => {
    vi.mocked(getFlag).mockImplementation(async (key: unknown) => key === FLAGS.QUEEN_CARD_INTERCEPTION);
    const askUser = capturingAskUser('corr-su');

    await (askChoiceTool as any).handler(
      { question: 'q?', options: [{ id: 'a', label: 'A' }] },
      suCtx(askUser),
    );

    const spec = askUser.mock.calls[0][0] as { timeoutMs?: number };
    expect(spec.timeoutMs).toBeUndefined();
    expect((await listEscalations()).length).toBe(0);
  });

  it('bee + flag OFF: legacy un-intercepted path (no timeout, no escalation)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const askUser = capturingAskUser('corr-off');

    await (askChoiceTool as any).handler(
      { question: 'q?', options: [{ id: 'a', label: 'A' }] },
      beeCtx(askUser),
    );

    const spec = askUser.mock.calls[0][0] as { timeoutMs?: number };
    expect(spec.timeoutMs).toBeUndefined();
    expect((await listEscalations()).length).toBe(0);
  });
});
