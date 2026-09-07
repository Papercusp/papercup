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
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(), onFlagChange: vi.fn() }));
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
  const calls = askUser.mock.calls;
  return calls[0][0] as Record<string, unknown>;
}

describe('chat:ask_choice handler', () => {
  it('admits the public Papercup role while retaining the chat:write capability gate', () => {
    expect((askChoiceTool as any).agentRoles).toContain('papercup');
    expect((askChoiceTool as any).capability).toBe('chat:write');
  });

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

  it('keeps the human wait outside both the 60s tool default and the 60s ambient workspace transaction', () => {
    // This tool BLOCKS on a real human clicking a card, which can easily
    // take >60s — without an explicit override the dispatch-stack default
    // (`exec.tool.timeoutSec ?? 60`) fires an abort at 60s while ctx.askUser
    // keeps waiting and eventually resolves anyway, surfacing a spurious
    // "exceeded timeout of 60s (handler returned but signal had aborted)"
    // watchdog error (EI-288: observed 15/25 recent calls before this fix).
    const metadata = askChoiceTool as unknown as {
      timeoutSec?: number;
      skipWorkspaceTx?: boolean;
    };
    expect(metadata.timeoutSec).toBe(600);
    // EI-21236181877481513: ctx.askUser can legitimately wait for minutes.
    // Holding the synthesized workspace tx while it waits makes Postgres kill
    // that idle transaction at 60s and the brain retry the same card forever.
    expect(metadata.skipWorkspaceTx).toBe(true);
  });

  it('documents the bounded text fields that otherwise reject route cards', () => {
    const metadata = askChoiceTool as unknown as {
      description?: string;
      guidance?: { when?: string };
    };
    const guidance = `${metadata.description ?? ''} ${metadata.guidance?.when ?? ''}`;
    expect(guidance).toContain('question ≤500');
    expect(guidance).toContain('labels ≤80');
    expect(guidance).toContain('hints ≤120');
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
    const spec = firstSpec(askUser) as {
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
    const spec = firstSpec(askUser) as { presentation: { options: Array<{ id: string }> } };
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
    expect((firstSpec(askUser) as { presentation: { kind: string } }).presentation.kind)
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
    const spec = firstSpec(askUser) as { allowDecline?: boolean };
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
    const spec = firstSpec(askUser) as { presentation?: { kind: string; voiceAnswerable?: boolean } };
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
    const spec = firstSpec(askUser) as { presentation?: { kind: string; voiceAnswerable?: boolean } };
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
    const spec = firstSpec(askUser) as { presentation?: { kind: string; voiceAnswerable?: boolean } };
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
    vi.mocked(getFlag).mockImplementation(async (key: unknown) => key === FLAGS.MUG_CARD_INTERCEPTION);
    const askUser = capturingAskUser('corr-bee-1');

    await (askChoiceTool as any).handler(
      { question: 'deploy now?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] },
      beeCtx(askUser),
    );

    const spec = firstSpec(askUser) as { timeoutMs?: number };
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
    vi.mocked(getFlag).mockImplementation(async (key: unknown) => key === FLAGS.MUG_CARD_INTERCEPTION);
    const askUser = capturingAskUser('corr-su');

    await (askChoiceTool as any).handler(
      { question: 'q?', options: [{ id: 'a', label: 'A' }] },
      suCtx(askUser),
    );

    const spec = firstSpec(askUser) as { timeoutMs?: number };
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

    const spec = firstSpec(askUser) as { timeoutMs?: number };
    expect(spec.timeoutMs).toBeUndefined();
    expect((await listEscalations()).length).toBe(0);
  });
});

describe('argsSchema — stringified options coercion (operator_turns seq 11831, 2026-07-16)', () => {
  const schema = (askChoiceTool as { args: { parse: (v: unknown) => { options: unknown } } }).args;

  it('parses a JSON-string options array (the observed model encoding slip)', () => {
    const parsed = schema.parse({
      question: 'What next?',
      options:
        '[{"id": "stall", "label": "Unstick the placement stall", "style": "primary"}, {"id": "rubric", "label": "Grade the overdue release rubric"}]',
    });
    expect(Array.isArray(parsed.options)).toBe(true);
    expect((parsed.options as Array<{ id: string }>).map((o) => o.id)).toEqual([
      'stall',
      'rubric',
    ]);
  });

  it('still rejects a non-array JSON string and plain garbage', () => {
    expect(() =>
      schema.parse({ question: 'q?', options: '{"id":"a","label":"A"}' }),
    ).toThrow();
    expect(() => schema.parse({ question: 'q?', options: 'not json at all' })).toThrow();
  });

  it('leaves a real array untouched', () => {
    const parsed = schema.parse({ question: 'q?', options: [{ id: 'a', label: 'A' }] });
    expect((parsed.options as Array<{ id: string }>)[0]).toMatchObject({ id: 'a', label: 'A' });
  });

  it('ADVERTISES the string form too — the calling harness validates raw input against the advertised JSON schema before zod runs (seq 12076)', async () => {
    const { toArgsJsonSchema } = await import('@papercusp/agent-mcp');
    // WI-5217: RoleToolDefinition now carries enough required fields that TS no longer
    // considers it "sufficiently overlapping" with the narrow `{ args: never }` shape for
    // a direct `as` — go through `unknown` first, per the compiler's own suggestion.
    const js = toArgsJsonSchema('chat:ask_choice', (askChoiceTool as unknown as { args: never }).args) as {
      properties?: { options?: { anyOf?: Array<{ type?: string }> } };
    };
    const branches = js.properties?.options?.anyOf ?? [];
    expect(branches.some((b) => b.type === 'array')).toBe(true);
    expect(branches.some((b) => b.type === 'string')).toBe(true);
  });
});

// EI-289 regression: the watchdog-reported symptom was a BARE zod message
// ("Too small: expected array to have >=1 items") on an empty `options`
// array, giving the caller no idea what to supply. That reflects OLD
// behavior — the schema (present since this file's creation, per the
// "Caller-DX (watchdog P-006)" comment above optionsArraySchema) has always
// carried a custom actionable .min(1, …) message. Pin it so a future schema
// edit can't silently regress back to the bare zod default.
describe('argsSchema — empty options gets an actionable message (EI-289)', () => {
  const schema = (askChoiceTool as { args: { parse: (v: unknown) => unknown } }).args;

  it('rejects an empty options array with the actionable custom message, not the bare zod default', () => {
    try {
      schema.parse({ question: 'q?', options: [] });
      throw new Error('expected schema.parse to throw');
    } catch (err) {
      const message = String(err);
      expect(message).toContain('chat:ask_choice needs at least one option');
      expect(message).not.toContain('Too small: expected array to have');
    }
  });
});
