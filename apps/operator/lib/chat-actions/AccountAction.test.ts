/**
 * ACCOUNT pill (WI-6509 / hud-chat-owner-controls-2026-08-11 P-003).
 *
 * These cases are the plan's decisions made falsifiable, not a coverage pass.
 * The three that would otherwise be discovered live, on a real session:
 *   • an UNKNOWN pin renders no pill (D-005 §5) — the "plausible-but-unsourced
 *     value is worse than the gap" rule;
 *   • the default-account row is PRESENT and NOT settable (D-006 §A);
 *   • a durable-but-not-live pin does NOT report success (D-009 §B) — the
 *     accepted-but-modified case, confirmed in gateway.ts's own handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { accountOptions, readAccountPin } from './AccountAction';
import type { ChatActionContext, ChatModeAction, ChatModeOption } from './types';

const fetchSyncQueryMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  fetchSyncQuery: (...args: unknown[]) => fetchSyncQueryMock(...args) as unknown,
}));

// Side-effect import — registers the axis, exactly as lib/chat-actions/index.ts
// does. (That barrel line is the WI-6450 trap: without it the axis is
// tree-shaken out and the pill never renders.)
import './AccountAction';

const OWNER = 'su-abc123';
const fetchMock = vi.fn();

function axis(): ChatModeAction {
  const a = getChatModeAction('mode-account');
  if (!a) throw new Error('mode-account is not registered');
  return a;
}

/** ctx as the chat modal builds it, with the roster row's accountPin. */
function ctxWith(accountPin: unknown): ChatActionContext {
  return { sessionOwnerId: OWNER, accountPin };
}

async function optionsOf(ctx: ChatActionContext): Promise<ChatModeOption[]> {
  return await axis().options(ctx);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, appliedLive: true }) });
  vi.stubGlobal('fetch', fetchMock);
  fetchSyncQueryMock.mockReset();
  fetchSyncQueryMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountAction — registration + shape', () => {
  it('registers ONE searchable axis in the config group, capped ACCT', () => {
    const a = axis();
    expect(a.cap).toBe('ACCT');
    expect(a.group).toBe('config');
    // The pool grows without limit (D-005 §4), so the menu must scroll + filter
    // rather than being a fixed short list.
    expect(a.searchable).toBe(true);
  });
});

describe('AccountAction — availability (D-005 §5: unknown ⇒ no pill)', () => {
  it('is UNAVAILABLE when the roster payload carries no accountPin field at all', () => {
    // An older operator / a mid-deploy SSE push. We cannot know the routing, and
    // a guessed value is worse than the visible gap.
    expect(axis().available({ sessionOwnerId: OWNER })).toBe(false);
  });

  it('is AVAILABLE when the roster says explicitly that there is no dynamic pin', () => {
    expect(axis().available(ctxWith(null))).toBe(true);
  });

  it('is UNAVAILABLE with no session to act on', () => {
    expect(axis().available({ sessionOwnerId: '', accountPin: null })).toBe(false);
  });
});

describe('AccountAction — current() is pure, sync, and does not overclaim', () => {
  it('reports the pinned account, and says SOFT pins are a preference not a guarantee', () => {
    const s = axis().current(ctxWith({ account: 'max-3', hard: false }));
    expect(s.value).toBe('max-3');
    expect(s.optionId).toBe('max-3');
    expect(s.on).toBe(true);
    // gateway.ts:74 — a soft pin yields when the account is paused/exhausted.
    expect(s.title).toMatch(/yields|preference/i);
  });

  it('distinguishes a HARD pin, whose failure mode is the opposite one', () => {
    const s = axis().current(ctxWith({ account: 'max-3', hard: true }));
    expect(s.title).toMatch(/never fails over/i);
  });

  it('an absent pin does NOT claim the session is on auto', () => {
    const s = axis().current(ctxWith(null));
    expect(s.on).toBe(false);
    // A static `--account=` spawn pin is invisible to this layer, so the tooltip
    // must say what is actually known rather than asserting auto routing.
    expect(s.title).toMatch(/launched with|cannot read/i);
  });

  it('costs no fetch — the whole reason it may stay synchronous', () => {
    axis().current(ctxWith({ account: 'max-3', hard: false }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchSyncQueryMock).not.toHaveBeenCalled();
  });
});

describe('AccountAction — the menu (D-006 §A: present but not settable)', () => {
  it('offers auto, the un-settable default row, and one row per pool account', async () => {
    fetchSyncQueryMock.mockResolvedValue([
      { id: 'max-3', label: 'Max 3', provider: 'anthropic', available: true },
      { id: 'api-key', label: 'API key', provider: 'anthropic', available: false },
    ]);
    const opts = await optionsOf(ctxWith(null));
    expect(opts.map((o) => o.id)).toEqual(['auto', '__default', 'api-key', 'max-3']);
  });

  it('the default system account is PRESENT, DISABLED, and says why', () => {
    const row = accountOptions([]).find((o) => o.id === '__default');
    expect(row).toBeDefined();
    expect(row?.disabled).toBe(true);
    // A disabled row with no reason is a dead end; the reason is the respawn.
    expect(row?.hint).toMatch(/respawn/i);
  });

  it('a rate-limited account is still offered, and says so', () => {
    const row = accountOptions([{ id: 'api-key', available: false }]).find((o) => o.id === 'api-key');
    expect(row?.disabled).toBeUndefined();
    expect(row?.hint).toMatch(/rate-limited|usage-walled/i);
  });

  it('fetches the pool LAZILY — nothing until the menu is opened', () => {
    expect(fetchSyncQueryMock).not.toHaveBeenCalled();
  });
});

describe('AccountAction — set() writes the verified paths, not the plausible ones', () => {
  it('a pool account → accounts:pin, SOFT (never hard from a one-click pill)', async () => {
    await axis().set(ctxWith(null), 'max-3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/admin/accounts/pin');
    expect(JSON.parse(init.body)).toEqual({ agent: OWNER, account: 'max-3' });
  });

  it('auto → accounts:UNPIN, not a pin to something called auto', async () => {
    await axis().set(ctxWith({ account: 'max-3', hard: false }), 'auto');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/admin/accounts/unpin');
    expect(JSON.parse(init.body)).toEqual({ agent: OWNER });
  });

  it('the default account REFUSES with the real reason, and writes nothing', async () => {
    await expect(axis().set(ctxWith(null), '__default')).rejects.toThrow(/respawn/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ACCEPTED-BUT-MODIFIED: a durable pin the gateway did not take live is NOT reported as done', async () => {
    // gateway.ts:97-102 returns ok:true with appliedLive:false + a warn. A
    // control reading the bare ok would tell the owner a pin is in force when
    // it lands on the gateway's next poll instead.
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, appliedLive: false, warn: 'saved durably' }),
    });
    await expect(axis().set(ctxWith(null), 'max-3')).rejects.toThrow(/next poll or restart/i);
  });

  it('a tool-level failure surfaces rather than passing as success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: false, error: "account 'ghost' is not in the gateway pool" }),
    });
    await expect(axis().set(ctxWith(null), 'ghost')).rejects.toThrow(/not in the gateway pool/i);
  });
});

describe('readAccountPin — the two absences are different answers', () => {
  it('undefined (field missing) ≠ null (no pin)', () => {
    expect(readAccountPin({ sessionOwnerId: OWNER })).toBeUndefined();
    expect(readAccountPin(ctxWith(null))).toBeNull();
  });

  it('a malformed pin reads as UNKNOWN, never as an empty pin', () => {
    expect(readAccountPin(ctxWith({ hard: true }))).toBeUndefined();
    expect(readAccountPin(ctxWith({ account: '' }))).toBeUndefined();
  });

  it('normalises a missing hard flag to soft', () => {
    expect(readAccountPin(ctxWith({ account: 'max-3' }))).toEqual({ account: 'max-3', hard: false });
  });
});
