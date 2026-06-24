/**
 * wake.test.ts — coord:wake (fleet-dispatch-wake-clarity P-006). The wake substrate
 * (wakeRecipients / reportIdleRecipients) + recipient resolve are mocked so we assert the
 * tool's contract: single-target only, fires the resolved key, and reports a dead miss LOUDLY.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wakeRecipients = vi.fn();
const reportIdleRecipients = vi.fn();
const resolveRecipients = vi.fn();
const isSelectorOrWildcard = vi.fn((id: string) => id === '*' || id === 'human' || id.startsWith('@'));

vi.mock('../inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
  reportIdleRecipients: (...a: unknown[]) => reportIdleRecipients(...a),
}));
vi.mock('../recipient-resolve', () => ({
  resolveRecipients: (...a: unknown[]) => resolveRecipients(...a),
  isSelectorOrWildcard: (id: string) => isSelectorOrWildcard(id),
}));
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-me', workspaceId: 'ws' }),
}));

import wake from './wake';

const ctx = { uiClientId: 'su-me', isSuperuser: true, workspaceId: 'ws' } as never;
const out = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);

describe('coord:wake', () => {
  beforeEach(() => {
    wakeRecipients.mockReset();
    reportIdleRecipients.mockReset();
    resolveRecipients.mockReset();
    resolveRecipients.mockResolvedValue({ resolved: ['su-bee-FULL'], unknown: [], ambiguous: [] });
    wakeRecipients.mockResolvedValue({ targets: ['su-bee-FULL'], keys: [], woken: 1, staged: 0 });
  });

  it('resolves the handle and fires the inbox-wake key, reporting woken', async () => {
    const res = out(await wake.handler({ to: 'su-bee' } as never, ctx));
    expect(resolveRecipients).toHaveBeenCalled();
    // wakeRecipients fired on the RESOLVED full ownerId
    expect(wakeRecipients.mock.calls[0][0]).toEqual(['su-bee-FULL']);
    expect(res).toMatchObject({ ok: true, to: 'su-bee-FULL', woken: 1 });
    expect(res.warning).toBeUndefined();
  });

  it('passes the note as the wake summary when given', async () => {
    await wake.handler({ to: 'su-bee', note: 'lane ready' } as never, ctx);
    expect(wakeRecipients.mock.calls[0][1]).toMatchObject({ summary: 'lane ready' });
  });

  it('refuses a wildcard/selector target (no thunder-herd)', async () => {
    const res = out(await wake.handler({ to: '*' } as never, ctx));
    expect(res).toMatchObject({ ok: false, error: 'not_a_single_target' });
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('a woken:0 miss to a DEAD target is a LOUD recipient_dead + relaunch warning', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-dead'], keys: [], woken: 0, staged: 0 });
    resolveRecipients.mockResolvedValue({ resolved: ['su-dead'], unknown: [], ambiguous: [] });
    reportIdleRecipients.mockResolvedValue({ idle: ['su-dead'], live: [], unknown: [], degraded: false });
    const res = out(await wake.handler({ to: 'su-dead' } as never, ctx));
    expect(res.woken).toBe(0);
    expect(res.recipient_dead).toEqual(['su-dead']);
    expect(res.warning).toMatch(/RELAUNCH|relaunch/);
  });

  it('a woken:0 miss to a live-but-paused target gets the softer confirm warning (no recipient_dead)', async () => {
    wakeRecipients.mockResolvedValue({ targets: ['su-paused'], keys: [], woken: 0, staged: 0 });
    resolveRecipients.mockResolvedValue({ resolved: ['su-paused'], unknown: [], ambiguous: [] });
    reportIdleRecipients.mockResolvedValue({ idle: [], live: ['su-paused'], unknown: [], degraded: false });
    const res = out(await wake.handler({ to: 'su-paused' } as never, ctx));
    expect(res.recipient_dead).toBeUndefined();
    expect(res.warning).toMatch(/confirm/i);
  });

  it('an unknown recipient is a loud error — nothing woken', async () => {
    resolveRecipients.mockResolvedValue({ resolved: [], unknown: ['nope'], ambiguous: [] });
    const res = out(await wake.handler({ to: 'nope' } as never, ctx));
    expect(res).toMatchObject({ ok: false, error: 'unknown_recipient' });
    expect(wakeRecipients).not.toHaveBeenCalled();
  });
});
