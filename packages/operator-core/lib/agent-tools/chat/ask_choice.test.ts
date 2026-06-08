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
