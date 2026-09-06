import { afterEach, describe, expect, it, vi } from 'vitest';

// The memo wraps the real listing by default; this unit test injects its own, so
// the heavy adv-sessions module (PG client, workspace registry) is stubbed out.
vi.mock('./adv-sessions', async (orig) => ({
  ...(await orig<typeof import('./adv-sessions')>()),
  listResumableSessions: vi.fn(async () => []),
}));

import type { AdvSessionRow } from './adv-sessions';
import {
  LATEST_AGENT_SESSION_SCAN,
  LATEST_AGENT_SESSION_TTL_MS,
  latestResumableSessionForAgentCached,
  resetLatestAgentSessionMemo,
} from './latest-agent-session-memo';

const row = (id: number, agent: string): AdvSessionRow => ({ id, agent }) as unknown as AdvSessionRow;

describe('latestResumableSessionForAgentCached (WI-2147549)', () => {
  afterEach(() => resetLatestAgentSessionMemo());

  it('memoizes the listing for the TTL and asks for the route’s 50-row window', async () => {
    const list = vi.fn(async () => [row(1, 'claude'), row(77, 'codex'), row(78, 'codex')]);
    let clock = 1_000;
    const now = () => clock;

    const first = await latestResumableSessionForAgentCached('codex', { list, now });
    const second = await latestResumableSessionForAgentCached('codex', { list, now });

    expect(first?.id).toBe(77); // first codex row in activity order wins — semantics unchanged
    expect(second).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(LATEST_AGENT_SESSION_SCAN);

    clock += LATEST_AGENT_SESSION_TTL_MS; // exactly at the TTL edge is stale (strict <)
    const third = await latestResumableSessionForAgentCached('codex', { list, now });
    expect(third?.id).toBe(77);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('memoizes a miss too, and keeps agents in separate entries', async () => {
    const list = vi.fn(async () => [row(5, 'claude')]);
    const now = () => 10_000;

    expect(await latestResumableSessionForAgentCached('codex', { list, now })).toBeNull();
    expect(await latestResumableSessionForAgentCached('codex', { list, now })).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);

    expect((await latestResumableSessionForAgentCached('claude', { list, now }))?.id).toBe(5);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('reset forgets everything so the next read re-lists', async () => {
    const list = vi.fn(async () => [row(9, 'codex')]);
    await latestResumableSessionForAgentCached('codex', { list, now: () => 1 });
    resetLatestAgentSessionMemo();
    await latestResumableSessionForAgentCached('codex', { list, now: () => 1 });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
