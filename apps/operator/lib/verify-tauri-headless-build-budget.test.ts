/**
 * EI-20229366113827667 — a cold cargo build must not consume the bridge
 * readiness budget.
 *
 * The verifier is an integration script that boots a real Tauri/Xvfb/sidecar
 * stack, so the recurrence guard pins the phase transition at the script's
 * wiring site and exercises the timing contract with a synthetic tauri.log.
 * The synthetic log deliberately places Cargo's Running marker at T+150s —
 * inside the separate build budget but beyond the 180s bridge budget that used
 * to be charged from launch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-20229366113827667 — build and bridge readiness use separate clocks', () => {
  it('exposes an independent bounded cargo-build timeout', () => {
    expect(src).toMatch(/VERIFY_TAURI_BUILD_TIMEOUT/);
    expect(src).toMatch(/BUILD_TIMEOUT="\$\{VERIFY_TAURI_BUILD_TIMEOUT:-300\}"/);
    expect(src).toMatch(/VERIFY_TAURI_TIMEOUT.*AFTER the desktop/);
  });

  it('waits for the desktop binary marker before entering the bridge wait', () => {
    const buildWait = src.match(
      /  until grep -qE "Running \.\*papercusp-desktop"[\s\S]*?\n  done/,
    )?.[0];
    const bridgeWait = src.match(
      /    until grep -q "dev bridge listening"[\s\S]*?\n    done/,
    )?.[0];

    expect(buildWait, 'the build-phase wait must remain explicit').toBeTruthy();
    expect(bridgeWait, 'the bridge-phase wait must remain explicit').toBeTruthy();
    expect(src.indexOf(buildWait!)).toBeLessThan(src.indexOf(bridgeWait!));
    expect(buildWait).toContain('BUILD_TIMEOUT');
    expect(buildWait).toContain('port_lost_to_squatter');

    const bridgeStart = src.indexOf(bridgeWait!);
    const reset = src.lastIndexOf('ELAPSED=0', bridgeStart);
    expect(reset).toBeGreaterThan(src.indexOf(buildWait!));
    expect(reset).toBeLessThan(bridgeStart);
    expect(src.slice(bridgeStart)).toContain(
      'bridge did not come up within ${TIMEOUT}s after the desktop binary started',
    );
  });

  it('keeps a synthetic cold build at T+150s alive through bridge readiness', () => {
    const syntheticLog = [
      ...Array.from({ length: 75 }, (_, i) => `cargo build progress ${i}`),
      'Running `/tmp/target/debug/papercusp-desktop`',
      ...Array.from({ length: 10 }, (_, i) => `bridge startup progress ${i}`),
      'dev bridge listening',
    ].join('\n');

    const buildTimeout = 300;
    const bridgeTimeout = 180;
    let phase: 'build' | 'bridge' = 'build';
    let elapsed = 0;
    let toreDown = false;

    for (const line of syntheticLog.split('\n')) {
      if (phase === 'build' && /Running .*papercusp-desktop/.test(line)) {
        phase = 'bridge';
        elapsed = 0;
        continue;
      }
      if (phase === 'bridge' && line.includes('dev bridge listening')) break;

      elapsed += 2;
      if (elapsed >= (phase === 'build' ? buildTimeout : bridgeTimeout)) {
        toreDown = true;
        break;
      }
    }

    expect(toreDown).toBe(false);
    expect(phase).toBe('bridge');
    expect(src).toContain('desktop binary started after ${BUILD_ELAPSED}s');
    expect(src).toContain('ELAPSED="$BUILD_ELAPSED"');
  });
});
