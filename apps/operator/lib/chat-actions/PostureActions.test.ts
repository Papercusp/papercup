import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { activeModes } from './PostureActions';
import type { ChatActionContext, ChatModeAction, ChatModeOption } from './types';

// WI-7471: GRADE's options() fetches the live rubric set. Mocked at the
// module boundary so every OTHER axis's options() stays a pure sync array and
// this file keeps testing descriptors rather than the sync layer.
const fetchSyncQueryMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  fetchSyncQuery: (...args: unknown[]) => fetchSyncQueryMock(...args) as unknown,
}));

// Side-effect import — registers the four posture mode-actions into the shared
// registry once for this file (same pattern as importing an Entry module from
// lib/chat-actions/index.ts).
import './PostureActions';

const ctx: ChatActionContext = { sessionOwnerId: 'su-abc123' };

/** ctx carrying a set of standing modes, in the roster row's own shape. */
function ctxWithModes(modes: unknown[]): ChatActionContext {
  return { sessionOwnerId: 'su-abc123', modes };
}

const fetchMock = vi.fn();

/**
 * A mode's options as a SYNC array.
 *
 * `options()` returns `ChatModeOption[] | Promise<ChatModeOption[]>` since
 * WI-7471. Every axis except GRADE is still sync, and asserting that is part of
 * the point: an axis that quietly went async would start costing a fetch on
 * menu open. So this narrows AND checks, rather than blanket-awaiting.
 */
function syncOptions(m: ChatModeAction): ChatModeOption[] {
  const opts = m.options(ctx);
  expect(Array.isArray(opts), `${m.id}.options() should still be synchronous`).toBe(true);
  return opts as ChatModeOption[];
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
  fetchSyncQueryMock.mockReset();
  fetchSyncQueryMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PostureActions — registration (P-005: mode-actions, not buttons)', () => {
  it('registers one autonomy axis + one pill per overlay, all in the "posture" group', () => {
    for (const id of ['mode-autonomy', 'mode-ideate', 'mode-drain', 'mode-grade']) {
      const m = getChatModeAction(id);
      expect(m, `${id} should be registered`).toBeDefined();
      expect(m?.group).toBe('posture');
    }
  });

  it('caps are the axis names the pill shows — AUTO, IDEATE, DRAIN, GRADE', () => {
    expect(getChatModeAction('mode-autonomy')?.cap).toBe('AUTO');
    expect(getChatModeAction('mode-ideate')?.cap).toBe('IDEATE');
    expect(getChatModeAction('mode-drain')?.cap).toBe('DRAIN');
    expect(getChatModeAction('mode-grade')?.cap).toBe('GRADE');
  });

  it('every axis is available only when the context carries a sessionOwnerId', () => {
    for (const id of ['mode-autonomy', 'mode-ideate', 'mode-drain', 'mode-grade']) {
      const m = getChatModeAction(id)!;
      expect(m.available(ctx)).toBe(true);
      expect(m.available({ sessionOwnerId: '' })).toBe(false);
    }
  });
});

describe('activeModes — normalising the roster row shape', () => {
  // The roster types modes as Array<HudMode | string>: federation and a
  // mid-deploy SSE push both produce the bare-string form, so a pill that
  // handled only the object form would silently render "off" for an agent that
  // really is in AUTO — the worst possible failure for this control.
  it('reads both the object form and the bare-string form', () => {
    expect(activeModes(ctxWithModes([{ mode: 'auto' }, 'ideate']))).toEqual(new Set(['auto', 'ideate']));
  });

  it('is empty (never throws) for a missing or non-array modes field', () => {
    expect(activeModes({ sessionOwnerId: 'x' })).toEqual(new Set());
    expect(activeModes({ sessionOwnerId: 'x', modes: null })).toEqual(new Set());
    expect(activeModes({ sessionOwnerId: 'x', modes: 'auto' })).toEqual(new Set());
  });

  it('ignores malformed entries rather than dropping the good ones beside them', () => {
    expect(activeModes(ctxWithModes([null, { nope: 1 }, 'drain']))).toEqual(new Set(['drain']));
  });
});

describe('mode-autonomy — current()', () => {
  it('reports off, with the manual explanation, when neither autonomy mode is set', () => {
    const state = getChatModeAction('mode-autonomy')!.current(ctxWithModes([]));
    expect(state).toMatchObject({ value: 'off', on: false });
    expect(state.title).toMatch(/no standing autonomy mode/i);
  });

  it('reports on when auto is set', () => {
    expect(getChatModeAction('mode-autonomy')!.current(ctxWithModes(['auto']))).toMatchObject({
      value: 'on',
      on: true,
    });
  });

  it('reports the COLDER mode when both are somehow set', () => {
    // Defensive, and the direction matters: reporting "on" for an agent that is
    // actually cold-auto would understate how it behaves between wakes.
    expect(
      getChatModeAction('mode-autonomy')!.current(ctxWithModes(['auto', 'cold-auto'])),
    ).toMatchObject({ value: 'cold', on: true });
  });
});

describe('mode-autonomy — options() + set()', () => {
  it('offers manual/auto/cold-auto with registry-derived labels + hints', () => {
    const options = syncOptions(getChatModeAction('mode-autonomy')!);
    expect(options.map((o) => o.id)).toEqual(['manual', 'auto', 'cold-auto']);
    const auto = options.find((o) => o.id === 'auto');
    expect(auto?.label).toBe('AUTO — act, don’t ask');
    expect(auto?.hint).toMatch(/act on your own judgment/);
    const manual = options.find((o) => o.id === 'manual');
    expect(manual?.label).toBe('Manual');
    expect(manual?.hint).toMatch(/no standing autonomy mode/);
  });

  it('picking "auto" RECONCILES the axis — enables auto AND clears cold-auto', async () => {
    // The pre-P-005 implementation only enabled the chosen mode, so switching
    // cold-auto → auto left BOTH standing. Reconciling the whole axis is what
    // makes the pill's own reading trustworthy afterwards.
    await getChatModeAction('mode-autonomy')!.set(ctx, 'auto');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const byMode = Object.fromEntries(
      fetchMock.mock.calls.map((c) => {
        const body = JSON.parse(c[1].body as string);
        return [body.mode, body.enabled];
      }),
    );
    expect(byMode).toEqual({ auto: true, 'cold-auto': false });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/mode/set');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(first).toMatchObject({ agent: 'su-abc123', ownerDirected: true });
  });

  it('picking "cold-auto" enables cold-auto AND clears auto', async () => {
    await getChatModeAction('mode-autonomy')!.set(ctx, 'cold-auto');
    const byMode = Object.fromEntries(
      fetchMock.mock.calls.map((c) => {
        const body = JSON.parse(c[1].body as string);
        return [body.mode, body.enabled];
      }),
    );
    expect(byMode).toEqual({ auto: false, 'cold-auto': true });
  });

  it('picking "manual" clears BOTH autonomy-axis modes', async () => {
    await getChatModeAction('mode-autonomy')!.set(ctx, 'manual');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const modes = fetchMock.mock.calls
      .map((c) => JSON.parse(c[1].body as string))
      .sort((a, b) => a.mode.localeCompare(b.mode));
    expect(modes).toEqual([
      expect.objectContaining({ mode: 'auto', enabled: false }),
      expect.objectContaining({ mode: 'cold-auto', enabled: false }),
    ]);
  });

  it('a non-ok response throws with the mode + status in the message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(getChatModeAction('mode-autonomy')!.set(ctx, 'auto')).rejects.toThrow(
      /mode:set\((?:auto|cold-auto)\).*500/,
    );
  });

  it('a stickyConflict response throws a distinct, explanatory error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ ok: false, stickyConflict: true }),
    });
    await expect(getChatModeAction('mode-autonomy')!.set(ctx, 'auto')).rejects.toThrow(
      /owner-directed incumbent/,
    );
  });
});

describe('overlay pills — current(), options(), set()', () => {
  it('each overlay reads only its OWN mode', () => {
    const on = ctxWithModes(['ideate']);
    expect(getChatModeAction('mode-ideate')!.current(on)).toMatchObject({ value: 'on', on: true });
    expect(getChatModeAction('mode-drain')!.current(on)).toMatchObject({ value: 'off', on: false });
    expect(getChatModeAction('mode-grade')!.current(on)).toMatchObject({ value: 'off', on: false });
  });

  it('carries the registry one-liner as the on-state hint, so no copy is written twice', () => {
    const ideate = getChatModeAction('mode-ideate')!;
    expect(ideate.current(ctxWithModes(['ideate'])).title).toMatch(/ideation passes/);
    expect(syncOptions(ideate).find((o) => o.id === 'on')?.hint).toMatch(/ideation passes/);
  });

  it('offers exactly on/off — they are independent booleans, not a shared multi-select', () => {
    expect(syncOptions(getChatModeAction('mode-drain')!).map((o) => o.id)).toEqual(['on', 'off']);
  });

  it('writes only its own mode, leaving the other overlays untouched', async () => {
    // The old single `Overlays` checkbox reconciled all three on every submit,
    // so toggling one silently rewrote the other two. Per-pill writes mean a
    // pill can never clear a mode the user did not touch.
    //
    // (Moved off `mode-grade` in WI-7471 — grade no longer has an `on` option,
    // so asserting this through it would have been asserting against an id the
    // menu can never produce.)
    await getChatModeAction('mode-ideate')!.set(ctx, 'on');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      mode: 'ideate',
      enabled: true,
      agent: 'su-abc123',
      ownerDirected: true,
    });
  });

  it('picking "off" disables that one mode', async () => {
    await getChatModeAction('mode-drain')!.set(ctx, 'off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      mode: 'drain',
      enabled: false,
    });
  });
});

/* ── [owner 2026-08-03] "I want the rubric picker back, add that to the grade
      on/off toggle." (WI-7471)

   GRADE is the one axis whose "on" carries a VALUE, so it is not an on/off
   overlay: its menu is `Off` plus one row per ACTIVE rubric. These cases pin
   the three things that separate it from the plain overlays above. ── */
describe('mode-grade — the rubric picker lives ON the pill', () => {
  const rubricRows = [
    { rubricId: 'hive-coordination-health', characteristic: 'coordination', title: 'Hive coordination health', status: 'active' },
    { rubricId: 'draft-thing', characteristic: 'drafts', title: 'Draft thing', status: 'proposed' },
    { rubricId: 'old-thing', characteristic: 'legacy', title: 'Old thing', status: 'retired' },
  ];

  it('offers Off first, then one row per ACTIVE rubric — never a proposed or retired one', async () => {
    fetchSyncQueryMock.mockResolvedValue(rubricRows);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(fetchSyncQueryMock).toHaveBeenCalledWith({ queryName: 'rubrics.list', args: {} });
    expect(opts.map((o) => o.id)).toEqual(['off', 'hive-coordination-health']);
    expect(opts[1].label).toBe('Hive coordination health');
  });

  /* WI-6552 [owner 2026-07-27]: the owner met the old picker with no idea what
     it would do — "something that comes up that explains what grade mode is".
     That explanation was the deleted card's `prompt`; it must survive the move
     onto the pill, or this change re-creates the confusion it is restoring. */
  it('still EXPLAINS what grade mode is, now on the Off row', async () => {
    fetchSyncQueryMock.mockResolvedValue(rubricRows);
    const opts = await getChatModeAction('mode-grade')!.options(ctx);
    expect(opts[0].hint).toMatch(/score its own work against a rubric/i);
  });

  it('picking a rubric turns grade ON and names the rubric in the reason', async () => {
    await getChatModeAction('mode-grade')!.set(ctx, 'hive-coordination-health');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ mode: 'grade', enabled: true, agent: 'su-abc123', ownerDirected: true });
    // The rubric rides the free-text reason — the same carrier the deleted
    // GradeAction used, so chat-protocol still never learns what a rubric IS.
    expect(body.reason).toMatch(/hive-coordination-health/);
  });

  it('picking Off turns grade off and does NOT name a rubric', async () => {
    await getChatModeAction('mode-grade')!.set(ctx, 'off');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ mode: 'grade', enabled: false });
    expect(body.reason).not.toMatch(/rubric \S/);
  });

  /* The reason this axis is allowed to be async at all (types.ts): the fetch is
     paid on menu OPEN, never on render. If GRADE's options were ever resolved
     eagerly the popup would carry a standing rubrics.list read — the exact cost
     WI-6617 is removing from this screen. */
  it('fetches NOTHING until options() is actually called', () => {
    getChatModeAction('mode-grade')!.current(ctx);
    expect(fetchSyncQueryMock).not.toHaveBeenCalled();
  });
});
