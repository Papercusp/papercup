import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { activeModes } from './PostureActions';
import type { ChatActionContext } from './types';

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

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
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
    const options = getChatModeAction('mode-autonomy')!.options(ctx);
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
    expect(ideate.options(ctx).find((o) => o.id === 'on')?.hint).toMatch(/ideation passes/);
  });

  it('offers exactly on/off — they are independent booleans, not a shared multi-select', () => {
    expect(getChatModeAction('mode-drain')!.options(ctx).map((o) => o.id)).toEqual(['on', 'off']);
  });

  it('writes only its own mode, leaving the other overlays untouched', async () => {
    // The old single `Overlays` checkbox reconciled all three on every submit,
    // so toggling one silently rewrote the other two. Per-pill writes mean a
    // pill can never clear a mode the user did not touch.
    await getChatModeAction('mode-grade')!.set(ctx, 'on');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      mode: 'grade',
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
