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

  it('cancels a pending approval on interrupt without opening later questions', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 13, method: 'item/commandExecution/requestApproval', params: {} }, 'turn', f.reply);
    f.cards.cancel(); await flush();
    expect(f.replies).toEqual([{ id: 13, result: { decision: 'cancel' } }]);
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'closed', resolution: 'cancelled' });
  });
});
