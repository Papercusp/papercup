import { afterEach, describe, expect, it } from 'vitest';
import { _resetCardCorrelatorForTests, resolveCardResponse } from '@papercusp/agent-mcp';
import { SuNativeCards } from './su-session-native-cards';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';

afterEach(_resetCardCorrelatorForTests);
function fixture() {
  const events: SuSessionEventInput[] = [];
  const replies: RpcFrame[] = [];
  const cards = new SuNativeCards('workspace', 'native-card-test', (event) => events.push(event));
  const answer = (payload: unknown, workspaceId = 'workspace') => {
    const event = [...events].reverse().find((event) => event.type === 'card' && event.phase === 'opened');
    if (!event || event.type !== 'card' || event.phase !== 'opened') throw new Error('No pending card');
    return resolveCardResponse({ correlationId: event.card.correlationId, action: 'submit', payload, expectedWorkspaceId: workspaceId });
  };
  return { cards, events, replies, answer, reply: (frame: RpcFrame) => replies.push(frame) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
/** Labels of the most recently opened choice card. */
function openedChoiceLabels(events: SuSessionEventInput[]): string[] {
  const card = events.at(-1);
  const presentation = card?.type === 'card' && card.phase === 'opened' ? card.card.presentation : undefined;
  if (presentation?.kind !== 'radio' || !presentation.options) throw new Error('No permission card');
  return presentation.options.map((option) => option.label);
}

describe('native requests through the shared PUI card correlator', () => {
  it('requires the matching workspace and an explicit approval before answering Codex', async () => {
    const f = fixture();
    expect(f.cards.handle('codex', { id: 10, method: 'item/commandExecution/requestApproval', params: { command: 'touch approved.txt' } }, 'turn', f.reply)).toBe(true);
    expect(f.replies).toEqual([]);
    expect(f.answer({ picks: ['0'] }, 'wrong-workspace').ok).toBe(false);
    expect(f.answer({ picks: ['invalid'] }).ok).toBe(false);
    expect(f.replies).toEqual([]);
    expect(f.answer({ picks: ['0'] }).ok).toBe(true);
    await flush();
    expect(f.replies).toEqual([{ id: 10, result: { decision: 'accept' } }]);
    expect(f.answer({ picks: ['0'] }).ok).toBe(false);
  });

  it('declines file permission without granting it', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 11, method: 'item/fileChange/requestApproval', params: { reason: 'Write proposed file?' } }, 'turn', f.reply);
    f.answer({ picks: ['1'] }); await flush();
    expect(f.replies).toEqual([{ id: 11, result: { decision: 'decline' } }]);
  });

  it('maps a Codex question back to its native question id', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 12, method: 'item/tool/requestUserInput', params: {
      questions: [{ id: 'destination', question: 'Where should it go?', options: [{ label: 'Here' }, { label: 'There' }] }],
    } }, 'turn', f.reply);
    f.answer({ picks: ['1'] }); await flush();
    expect(f.replies).toEqual([{ id: 12, result: { answers: { destination: { answers: ['There'] } } } }]);
  });

  it('returns OMP text input and confirmation through native RPC', async () => {
    const f = fixture();
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'input', method: 'input', title: 'File name?' }, 'turn', f.reply);
    f.answer({ value: 'notes.txt' }); await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'input', value: 'notes.txt' }]);
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Proceed?' }, 'turn', f.reply);
    f.answer({ picks: ['0'] }); await flush();
    expect(f.replies[1]).toEqual({ type: 'extension_ui_response', id: 'confirm', confirmed: true });
  });

  it('preserves an explicitly empty OMP editor value', async () => {
    const f = fixture();
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'Edit text' }, 'turn', f.reply);
    expect(f.answer({ value: '' }).ok).toBe(true);
    await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'editor', value: '' }]);
  });

  it('cancels a pending approval on interrupt without opening later questions', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 13, method: 'item/commandExecution/requestApproval', params: {} }, 'turn', f.reply);
    f.cards.cancel(); await flush();
    expect(f.replies).toEqual([{ id: 13, result: { decision: 'cancel' } }]);
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'closed', resolution: 'cancelled' });
  });

  it('accepts Claude multiple selections and custom text through validated cards', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('AskUserQuestion', { questions: [{ question: 'Which features?', multiSelect: true,
      options: [{ label: 'Search' }, { label: 'Export' }] }] }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'question', requestId: 'request',
    });
    expect(f.answer({ picks: ['0', '0'] }).ok).toBe(false);
    expect(f.answer({ picks: ['0', '2'] }).ok).toBe(true);
    await flush();
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'opened', card: { presentation: { kind: 'text' } } });
    expect(f.answer({ value: 'Offline' }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which features?': 'Search, Offline' } } });
  });

  it('answers a wrapped Claude native question as a choice card instead of a generic MCP permission', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('mcp__papercusp-su__tools_invoke', {
      name: 'AskUserQuestion', args: { questions: [{ question: 'Keep or change?', multiSelect: false,
        options: [{ label: 'Keep' }, { label: 'Change' }] }] },
    }, 'turn', { signal: new AbortController().signal, toolUseID: 'wrapped-question', requestId: 'wrapped-request' });
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'opened',
      card: { prompt: 'Keep or change?', presentation: { kind: 'radio' } } });
    expect(openedChoiceLabels(f.events)).toEqual(['Keep', 'Change', 'Type a different answer']);
    expect(f.answer({ picks: ['1'] }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny',
      message: expect.stringContaining('"Keep or change?":"Change"') });
    expect(f.events.filter((event) => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
  });

  it('cancels only the aborted Claude request and leaves a concurrent permission answerable', async () => {
    const f = fixture(); const aborted = new AbortController();
    const first = f.cards.handleClaude('Bash', { command: 'first' }, 'turn', {
      signal: aborted.signal, toolUseID: 'first', requestId: 'first-request',
    });
    const second = f.cards.handleClaude('Bash', { command: 'second' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'second', requestId: 'second-request',
    });
    const secondCard = f.events.at(-1);
    if (secondCard?.type !== 'card' || secondCard.phase !== 'opened') throw new Error('No second permission card');
    aborted.abort();
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
    expect(resolveCardResponse({ correlationId: secondCard.card.correlationId, action: 'submit', payload: { picks: ['0'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(second).resolves.toMatchObject({ behavior: 'allow', updatedInput: { command: 'second' } });
  });

  it('offers Claude\'s remembered permission as a labelled session-only choice', async () => {
    const f = fixture();
    const toolName = 'mcp__papercusp-su__orders_disposition';
    const pending = f.cards.handleClaude(toolName, { id: 282 }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'remember', requestId: 'remember-request',
      suggestions: [
        { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });
    expect(openedChoiceLabels(f.events)).toEqual(['Approve', 'Decline',
      `Always allow ${toolName} until this session's runtime stops`]);
    expect(f.answer({ picks: ['2'] }).ok).toBe(true);
    // Never a settings-file write, and never a mode change the card did not name.
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { id: 282 },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }] });
  });

  it('keeps the plain two-choice card when Claude offers nothing to remember', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('Bash', { command: 'ls' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'plain', requestId: 'plain-request',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }],
    });
    expect(openedChoiceLabels(f.events)).toEqual(['Approve', 'Decline']);
    expect(f.answer({ picks: ['0'] }).ok).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });
});
