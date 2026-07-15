/**
 * WI-4975: a background subshell inherits its parent's EXIT trap. The
 * --boot-only port-lock keeper must clear teardown before waiting, otherwise
 * a normal wrapper exit destroys the isolated app it just handed to the user.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('WI-4975 — verify-tauri-headless --boot-only keeps the isolated app alive', () => {
  it('detaches the display and window manager from the launcher terminal', () => {
    expect(src).toMatch(/setsid Xvfb ":\$DISPLAY_NUM"/);
    expect(src).toMatch(/setsid env DISPLAY=":\$DISPLAY_NUM" openbox/);
  });

  it('clears teardown traps inside the background keeper before it can exit', () => {
    const branch = src.match(/if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/)?.[1];
    expect(branch).toBeTruthy();
    expect(branch).toMatch(
      /\( trap - EXIT INT TERM; while kill -0 "\$TAURI_PID"[^;]*; do sleep 2; done \) &/,
    );
  });

  it('does not start the keeper before clearing only the parent trap', () => {
    expect(src).not.toMatch(
      /\( while kill -0 "\$TAURI_PID"[^;]*; do sleep 2; done \) &\s*\n\s*PORT_LOCK_KEEPER_PID=\$!\s*\n\s*trap - EXIT INT TERM/,
    );
  });
});
