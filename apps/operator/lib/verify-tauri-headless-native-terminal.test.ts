/**
 * WI-3388 — the isolated Tauri verifier normally suppresses the native dock,
 * but native-terminal geometry needs the same provenance-checked Xvfb harness.
 * Pin the opt-in seam so future dock work can run live without an ad-hoc copy
 * of the launcher, while every unrelated verifier stays default-off.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('WI-3388 — verify-tauri-headless native-terminal opt-in', () => {
  it('defaults the native terminal off and validates the opt-in as a boolean switch', () => {
    expect(src).toContain('NATIVE_TERMINAL="${VERIFY_TAURI_NATIVE_TERMINAL:-0}"');
    expect(src).toMatch(/case "\$NATIVE_TERMINAL" in\s+0\|1\) ;;[\s\S]*?exit 2/);
  });

  it('passes the validated value into the isolated Tauri launch environment', () => {
    expect(src).toContain('PAPERCUSP_NATIVE_TERMINAL="$NATIVE_TERMINAL"');
    expect(src).not.toContain('PAPERCUSP_NATIVE_TERMINAL=0 \\\\');
  });
});
