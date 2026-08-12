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

/**
 * The gateway-free case (EI-20208335287200289, second half).
 *
 * A `--account=default` session bypasses the inference gateway, so `accounts:pin` writes a real
 * durable pin, returns ok — and the session keeps routing exactly as before. The pill used to
 * offer every pool account as a clickable row while its own tooltip said the spawn pin was
 * something "this control cannot read". It could: `launchArgv` is already on the same ctx.
 */
describe('--account=default is READ from the launch argv, not guessed at', () => {
  const argvCtx = (launchArgv: unknown): ChatActionContext =>
    ({ sessionOwnerId: OWNER, accountPin: null, launchArgv }) as ChatActionContext;

  const DEFAULT_ARGV = ['psu', '--no-picker', '--account=default'];
  /* The SECOND argv shape: a console launch records [terminal, greetingCmd] with the flags
     embedded in one shell string. A parser that only handles tokens reads this as "no --account"
     and re-offers the useless rows — the same shape that made the MODEL pill lie (D-002). */
  const DEFAULT_ARGV_SHELL = ['gnome-terminal', "echo 'resuming'; exec psu --resume=x --account='default'"];

  it.each([
    ['token argv', DEFAULT_ARGV],
    ['embedded shell argv', DEFAULT_ARGV_SHELL],
  ])('disables every gateway-routed row for a gateway-free session (%s)', (_label, argv) => {
    const rows = accountOptions([{ id: 'aviynw3' }, { id: 'aviynw4' }], 'default');
    for (const r of rows) {
      expect(r.disabled, `${r.id} must not be offered as settable`).toBe(true);
    }
    // and the reason is on the row, not only in a tooltip somewhere else
    expect(rows.find((o) => o.id === 'aviynw3')!.hint).toMatch(/bypasses the inference gateway/i);
    // the read that feeds it handles BOTH recorded argv shapes
    expect(axis().current(argvCtx(argv)).title).toMatch(/bypasses the inference gateway/i);
  });

  it('REFUSES the write rather than reporting a pin that can never take effect', async () => {
    // fetch is NOT mocked to fail here — the point is that a gateway-free session must be refused
    // BEFORE the call, because the call itself would have succeeded and reported ok.
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, appliedLive: true }) });
    await expect(axis().set(argvCtx(DEFAULT_ARGV), 'aviynw3')).rejects.toThrow(/respawn/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a gateway-routed session is unaffected — rows stay settable', async () => {
    const rows = accountOptions([{ id: 'aviynw3' }], 'auto');
    expect(rows.find((o) => o.id === 'aviynw3')!.disabled).toBeUndefined();
    expect(rows.find((o) => o.id === 'auto')!.disabled).toBeUndefined();
    // ...and only the un-settable __default row is still disabled, as before this change
    expect(rows.find((o) => o.id === '__default')!.disabled).toBe(true);

    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, appliedLive: true }) });
    await expect(axis().set(argvCtx(['psu', '--account=auto']), 'aviynw3')).resolves.not.toThrow();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('an UNKNOWN argv does not disable the menu — absence is not evidence of --account=default', () => {
    // [] is the "no launch record" case adv-roster produces; undefined is an older payload.
    for (const argv of [[], undefined]) {
      expect(axis().current(argvCtx(argv)).title).not.toMatch(/bypasses the inference gateway/i);
    }
    const rows = accountOptions([{ id: 'aviynw3' }], undefined);
    expect(rows.find((o) => o.id === 'aviynw3')!.disabled).toBeUndefined();
  });

  it('a STATIC pool pin at spawn is reported instead of claimed unreadable', () => {
    expect(axis().current(argvCtx(['psu', '--account=aviynw3'])).title).toMatch(/--account=aviynw3/);
  });

  /* THE FIELD THIS SUITE NEVER ASSERTED, and the reason a wrong reading shipped.
     `value` is the at-a-glance pill text; `title` is one click away. Every case above
     checked the title, so `value: 'auto'` — hardcoded for all four unpinned branches —
     was never exercised, and a --account=default session rendered "ACCT auto" live on
     the rig: the OPPOSITE routing (gateway bypassed vs gateway-routed-with-failover).
     A control that contradicts itself between its label and its own menu is worse than
     one that says nothing, so these pin the label, not just the explanation. */
  it('renders the LAUNCH account as the pill value — never a blanket "auto"', () => {
    expect(axis().current(argvCtx(DEFAULT_ARGV)).value).toBe('default');
    /* the shell-embedded argv shape must reach the same reading, or the label lies
       on exactly the sessions the console launches (D-002). */
    expect(axis().current(argvCtx(DEFAULT_ARGV_SHELL)).value).toBe('default');
    expect(axis().current(argvCtx(['psu', '--account=auto'])).value).toBe('auto');
    expect(axis().current(argvCtx(['psu', '--account=aviynw3'])).value).toBe('aviynw3');
  });

  it('says "unpinned" instead of claiming auto when the launch routing is UNKNOWN', () => {
    /* undefined argv = we have no argv to read, which is not evidence of auto routing.
       This is the same unknown-is-not-a-value rule the MODEL pill follows by omitting
       itself; here the pill is already shown, so the value carries the honesty. */
    expect(axis().current(argvCtx(undefined)).value).toBe('unpinned');
    expect(axis().current(argvCtx([])).value).toBe('unpinned');
  });
});
