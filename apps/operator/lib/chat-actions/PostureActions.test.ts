import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatAction } from './registry';
import type { ChatActionContext } from './types';

// Side-effect import — registers posture-autonomy/posture-overlays into the
// shared registry once for this file (same pattern as importing an Entry
// module from lib/chat-actions/index.ts).
import './PostureActions';

const ctx: ChatActionContext = { sessionOwnerId: 'su-abc123' };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PostureActions — registration', () => {
  it('registers posture-autonomy and posture-overlays, both in the "posture" group', () => {
    const autonomy = getChatAction('posture-autonomy');
    const overlays = getChatAction('posture-overlays');
    expect(autonomy).toBeDefined();
    expect(overlays).toBeDefined();
    expect(autonomy?.group).toBe('posture');
    expect(overlays?.group).toBe('posture');
  });

  it('both actions are available only when the context carries a sessionOwnerId', () => {
    const autonomy = getChatAction('posture-autonomy')!;
    const overlays = getChatAction('posture-overlays')!;
    expect(autonomy.available(ctx)).toBe(true);
    expect(overlays.available(ctx)).toBe(true);
    expect(autonomy.available({ sessionOwnerId: '' })).toBe(false);
    expect(overlays.available({ sessionOwnerId: '' })).toBe(false);
  });
});

describe('PostureActions — posture-autonomy params (radio, sourced from the mode registry)', () => {
  it('offers manual/auto/cold-auto with registry-derived labels + hints, allowDecline true', async () => {
    const autonomy = getChatAction('posture-autonomy')!;
    const spec = await autonomy.params!(ctx);
    expect(spec.presentation?.kind).toBe('radio');
    expect(spec.allowDecline).toBe(true);
    const ids = spec.presentation?.options?.map((o) => o.id);
    expect(ids).toEqual(['manual', 'auto', 'cold-auto']);
    const auto = spec.presentation?.options?.find((o) => o.id === 'auto');
    expect(auto?.label).toBe('AUTO — act, don’t ask');
    expect(auto?.hint).toMatch(/act on your own judgment/);
    const manual = spec.presentation?.options?.find((o) => o.id === 'manual');
    expect(manual?.label).toBe('Manual');
    expect(manual?.hint).toMatch(/no standing autonomy mode/);
  });
});

describe('PostureActions — posture-overlays params (checkbox, sourced from the mode registry)', () => {
  it('offers ideate/drain/grade with registry-derived labels + hints', async () => {
    const overlays = getChatAction('posture-overlays')!;
    const spec = await overlays.params!(ctx);
    expect(spec.presentation?.kind).toBe('checkbox');
    const ids = spec.presentation?.options?.map((o) => o.id);
    expect(ids).toEqual(['ideate', 'drain', 'grade']);
    const ideate = spec.presentation?.options?.find((o) => o.id === 'ideate');
    expect(ideate?.label).toMatch(/IDEATE/);
    expect(ideate?.hint).toMatch(/ideation passes/);
  });
});

describe('PostureActions — posture-autonomy run()', () => {
  it('picking "auto" posts a single enable=true mode:set for auto', async () => {
    const autonomy = getChatAction('posture-autonomy')!;
    await autonomy.run(ctx, { picks: ['auto'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/mode/set');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ mode: 'auto', enabled: true, agent: 'su-abc123', ownerDirected: true });
  });

  it('picking "cold-auto" posts a single enable=true mode:set for cold-auto', async () => {
    const autonomy = getChatAction('posture-autonomy')!;
    await autonomy.run(ctx, { picks: ['cold-auto'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ mode: 'cold-auto', enabled: true });
  });

  it('picking "manual" clears BOTH autonomy-axis modes (auto + cold-auto, enabled:false)', async () => {
    const autonomy = getChatAction('posture-autonomy')!;
    await autonomy.run(ctx, { picks: ['manual'] });
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
    const autonomy = getChatAction('posture-autonomy')!;
    await expect(autonomy.run(ctx, { picks: ['auto'] })).rejects.toThrow(/mode:set\(auto\).*500/);
  });

  it('a stickyConflict response throws a distinct, explanatory error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ ok: false, stickyConflict: true }),
    });
    const autonomy = getChatAction('posture-autonomy')!;
    await expect(autonomy.run(ctx, { picks: ['auto'] })).rejects.toThrow(/owner-directed incumbent/);
  });
});

describe('PostureActions — posture-overlays run()', () => {
  it('reconciles all three overlay ids explicitly — checked ones true, unchecked ones false', async () => {
    const overlays = getChatAction('posture-overlays')!;
    await overlays.run(ctx, { picks: ['ideate', 'grade'] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const byMode = Object.fromEntries(
      fetchMock.mock.calls.map((c) => {
        const body = JSON.parse(c[1].body as string);
        return [body.mode, body.enabled];
      }),
    );
    expect(byMode).toEqual({ ideate: true, drain: false, grade: true });
  });

  it('an empty pick set disables all three overlays', async () => {
    const overlays = getChatAction('posture-overlays')!;
    await overlays.run(ctx, { picks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect(body.enabled).toBe(false);
    }
  });
});
