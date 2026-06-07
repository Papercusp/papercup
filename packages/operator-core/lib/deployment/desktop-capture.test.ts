import { describe, it, expect } from 'vitest';
import {
  buildDesktopCaptureScript,
  captureVideoSize,
  DESKTOP_CAPTURE_DIR,
} from './desktop-capture';

describe('captureVideoSize', () => {
  it('extracts WxH from a WxHxDEPTH geometry', () => {
    expect(captureVideoSize('1920x1080x24')).toBe('1920x1080');
    expect(captureVideoSize('1280x800x24')).toBe('1280x800');
  });

  it('falls back to 1080p on a malformed geometry', () => {
    expect(captureVideoSize('huge')).toBe('1920x1080');
  });
});

describe('buildDesktopCaptureScript', () => {
  const script = buildDesktopCaptureScript({ displays: [99, 100], geometry: '1920x1080x24' });

  it('is a bash loop with the default interval (env-overridable)', () => {
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('INTERVAL="${PAPERCUSP_DESKTOP_CAPTURE_INTERVAL:-5}"');
    expect(script).toContain('while true; do');
    expect(script).toContain('sleep "$INTERVAL"');
  });

  it('emits one capture block per display', () => {
    for (const d of [99, 100]) {
      expect(script).toContain(`-i :${d} -frames:v 1`);
      expect(script).toContain(`${DESKTOP_CAPTURE_DIR}/display-${d}.jpg.tmp`);
    }
    expect(script).not.toContain(':101');
  });

  it('writes atomically (tmp + mv) so a pull never reads a torn frame', () => {
    expect(script).toContain(`mv -f "${DESKTOP_CAPTURE_DIR}/display-99.jpg.tmp" "${DESKTOP_CAPTURE_DIR}/display-99.jpg"`);
  });

  it('pauses idle displays (no clients beyond the WM) and clears their stale frame', () => {
    expect(script).toContain(`DISPLAY=:99 xlsclients 2>/dev/null | grep -civ 'openbox'`);
    expect(script).toContain(`rm -f "${DESKTOP_CAPTURE_DIR}/display-99.jpg"`);
  });

  it('uses the geometry-derived video size', () => {
    const s = buildDesktopCaptureScript({ displays: [99], geometry: '1280x800x24' });
    expect(s).toContain('-video_size 1280x800');
  });

  it('honors a custom interval', () => {
    const s = buildDesktopCaptureScript({ displays: [99], geometry: '1920x1080x24', intervalSec: 10 });
    expect(s).toContain(':-10}"');
  });
});
