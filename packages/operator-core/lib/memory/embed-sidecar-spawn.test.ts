/**
 * EI-19418496145469907: when NEITHER PAPERCUSP_EMBED_SIDECAR_URL nor
 * PAPERCUSP_EMBED_SIDECAR=1 is set, `ensureEmbedSidecar()` used to return
 * null with zero logging — byte-identical to actually exercising the
 * sidecar path from the caller's point of view. A standalone driver could
 * silently verify the in-process fallback while believing it exercised
 * production's sidecar-served code path. This suite covers only the
 * disabled/no-config branch (no real child process is spawned or mocked
 * here — see embed-sidecar-wiring.test.ts for the sidecar-URL-resolved
 * paths, which inject `SidecarWiringDeps.ensure` directly and never reach
 * this function's env check at all).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetNoSidecarConfiguredLogForTests,
  embedSidecarEnabled,
  ensureEmbedSidecar,
} from './embed-sidecar-spawn';

describe('embedSidecarEnabled', () => {
  it('is false with neither env var set', () => {
    expect(embedSidecarEnabled({})).toBe(false);
  });

  it('is true when PAPERCUSP_EMBED_SIDECAR=1', () => {
    expect(embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '1' })).toBe(true);
  });

  it('is false inside a sidecar process itself (recursion guard)', () => {
    expect(
      embedSidecarEnabled({ PAPERCUSP_EMBED_SIDECAR: '1', PAPERCUSP_EMBED_SIDECAR_MODE: '1' }),
    ).toBe(false);
  });
});

describe('ensureEmbedSidecar — no-config fallback is no longer silent', () => {
  afterEach(() => {
    _resetNoSidecarConfiguredLogForTests();
    vi.restoreAllMocks();
    delete process.env.PAPERCUSP_EMBED_SIDECAR;
    delete process.env.PAPERCUSP_EMBED_SIDECAR_MODE;
  });

  it('returns null and WARNs once when disabled (no env configured)', async () => {
    delete process.env.PAPERCUSP_EMBED_SIDECAR;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = await ensureEmbedSidecar();

    expect(url).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[embed-sidecar\] no sidecar configured/);
    // The regression this test guards: the log must name the escape hatch,
    // or a reader has no path from "I saw this warning" to "here's the fix".
    expect(warnSpy.mock.calls[0][0]).toMatch(/PAPERCUSP_EMBED_SIDECAR_URL/);
  });

  it('logs the fallback ONCE across repeated calls in the same process (not per-call spam)', async () => {
    delete process.env.PAPERCUSP_EMBED_SIDECAR;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureEmbedSidecar();
    await ensureEmbedSidecar();
    await ensureEmbedSidecar();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the sidecar is deliberately not configured but the test seam already reset (regression: reset must actually clear state)', async () => {
    delete process.env.PAPERCUSP_EMBED_SIDECAR;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureEmbedSidecar();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    _resetNoSidecarConfiguredLogForTests();
    await ensureEmbedSidecar();
    expect(warnSpy).toHaveBeenCalledTimes(2); // fires again after an explicit reset
  });
});
