/**
 * CTX axis — the context-runway pill (WI-6507).
 *
 * The tests that earn their place here are the REFUSAL ones. This tool answers
 * "no, and I changed nothing" inside an HTTP 200 body, so the failure this axis
 * is most likely to ship is a control that reports success for a write that
 * never happened (hud-chat-owner-controls-2026-08-11 D-010). Registration and
 * formatting are cheap to check and included; the refusal branches are the point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { currentLimit, formatTokens, postCompactionLimit } from './ContextLimitAction';
import type { ChatActionContext, ChatModeAction, ChatModeOption } from './types';

// Side-effect import — registers the CTX axis into the shared registry.
import './ContextLimitAction';

const ctx: ChatActionContext = { sessionOwnerId: 'su-abc123' };

/** ctx carrying a roster row's compaction limit. */
function ctxWithLimit(compactionLimit: unknown): ChatActionContext {
  return { sessionOwnerId: 'su-abc123', compactionLimit };
}

const fetchMock = vi.fn();

/** The axis, or a loud failure — every test below needs it registered. */
function axis(): ChatModeAction {
  const m = getChatModeAction('mode-context-limit');
  expect(m, 'mode-context-limit should be registered').toBeDefined();
  return m as ChatModeAction;
}

/** Body-carrying fetch reply, the shape the admin proxy actually returns. */
function reply(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(reply({ ok: true, compactionLimit: 160_000 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CTX — registration and shape (D-005)', () => {
  it('registers one pill in the CONFIG group, beside ACCT rather than the mode axes', () => {
    // D-006: posture = the four mode axes (what stance the agent takes).
    // CTX and ACCT are session configuration, not a stance, and the owner asked
    // for these controls to be coherent rather than three unrelated affordances.
    expect(axis().group).toBe('config');
    expect(axis().cap).toBe('CTX');
  });

  it('is NOT searchable — the option set is bounded', () => {
    // D-005 draws the line at boundedness: a search box over a fixed ladder is
    // noise. If someone later makes the ladder dynamic, this should fail and be
    // reconsidered rather than silently drifting.
    expect(axis().searchable).toBeFalsy();
  });

  it('offers options synchronously — opening the menu must not cost a fetch', () => {
    const opts = axis().options(ctx);
    expect(Array.isArray(opts)).toBe(true);
    expect((opts as ChatModeOption[]).length).toBeGreaterThan(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every option id parses back to a finite token count', () => {
    for (const o of axis().options(ctx) as ChatModeOption[]) {
      expect(Number.isFinite(Number(o.id)), `${o.id} should be numeric`).toBe(true);
    }
  });
});

describe('CTX — current() is pure, sync, and reads the roster row', () => {
  it('reports the session limit without fetching', () => {
    const state = axis().current(ctxWithLimit(160_000));
    expect(state.value).toBe('160k');
    expect(state.on).toBe(true);
    expect(state.optionId).toBe('160000');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports "auto" — NOT a made-up number — when no limit is set', () => {
    // The pill must not invent a default to display. A null limit genuinely
    // means "whatever this model and role default to", which the reader can
    // only be told, not shown.
    const state = axis().current(ctxWithLimit(null));
    expect(state.value).toBe('auto');
    expect(state.on).toBe(false);
    expect(state.optionId).toBeUndefined();
  });

  it('treats a missing or non-numeric field as unset rather than throwing', () => {
    // An older operator's roster payload has no such field; federation and a
    // mid-deploy SSE push can both produce an odd shape.
    expect(axis().current({ sessionOwnerId: 'su-abc123' }).value).toBe('auto');
    expect(axis().current(ctxWithLimit('160000')).value).toBe('auto');
    expect(currentLimit(ctxWithLimit(Number.NaN))).toBeNull();
  });
});

describe('CTX — set() posts through the admin proxy', () => {
  it('POSTs the target session id, not the caller', async () => {
    await axis().set(ctx, '200000');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/admin/config/set-compaction-limit');
    expect(JSON.parse(init.body)).toEqual({ limit: 200_000, ownerId: 'su-abc123' });
  });

  it('rejects an unparseable option instead of POSTing a NaN limit', async () => {
    await expect(axis().set(ctx, 'not-a-number')).rejects.toThrow(/unrecognised/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CTX — a refusal inside a 200 must NOT read as success (D-010)', () => {
  it('throws, naming the REAL ceiling, when the limit exceeds the cap', async () => {
    // The exact failure this axis exists to avoid: r.ok is true, and nothing
    // was written. A control that trusted the HTTP status would report success.
    fetchMock.mockResolvedValue(
      reply({ ok: false, error: 'limit_exceeds_cap', cap: 200_000, requested: 825_000 }),
    );
    await expect(postCompactionLimit('su-abc123', 825_000)).rejects.toThrow(/200k/);
  });

  it('tells the owner nothing was changed, rather than implying a partial write', async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, error: 'limit_exceeds_cap', cap: 200_000 }));
    await expect(postCompactionLimit('su-abc123', 825_000)).rejects.toThrow(/nothing was changed/i);
  });

  it('does NOT report a cap problem when the session simply ended', async () => {
    // ok:false is ambiguous — it is `persisted != null`, so it also means "no
    // live presence row". Reporting a ceiling problem here would send the reader
    // hunting for one that does not exist (EI-20187186554229192).
    fetchMock.mockResolvedValue(
      reply({ ok: false, note: 'no live presence row for su-abc123 — limit not persisted (it may have ended)' }),
    );
    const err = await postCompactionLimit('su-abc123', 160_000).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/ceiling/i);
  });

  it('surfaces an authorization refusal verbatim rather than as a generic failure', async () => {
    // The wall the admin-UI identity hits without the ADMIN_COORD_UI_OWNER grant
    // in set-compaction-limit-core. If that grant is ever removed, this is the
    // message the owner would see, and it should be the real one.
    fetchMock.mockResolvedValue(
      reply({ ok: false, error: 'not_authorized', message: 'Setting su-abc123 is restricted to the leader…' }),
    );
    await expect(postCompactionLimit('su-abc123', 160_000)).rejects.toThrow(/restricted to the leader/);
  });

  it('throws on a transport failure', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'boom' }, false));
    await expect(postCompactionLimit('su-abc123', 160_000)).rejects.toThrow(/500/);
  });

  it('accepts a successful write', async () => {
    fetchMock.mockResolvedValue(reply({ ok: true, compactionLimit: 160_000 }));
    await expect(postCompactionLimit('su-abc123', 160_000)).resolves.toBeUndefined();
  });
});

describe('formatTokens', () => {
  it('renders compactly enough for a pill', () => {
    expect(formatTokens(20_000)).toBe('20k');
    expect(formatTokens(160_000)).toBe('160k');
    expect(formatTokens(825_000)).toBe('825k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });
});
