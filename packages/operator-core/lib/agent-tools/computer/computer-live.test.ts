/**
 * computer-live.test.ts — OPT-IN live end-to-end proof of capability:computer against
 * a REAL Xvfb sandbox desktop (no mocks, no seams). It exercises the OPERATIVE fleet
 * path end to end:
 *   ensureHiveDesktop(hive)         → leases a real Xvfb+openbox desktop in THIS process's Map
 *   runComputerAction(.., {harnessSlug}) → resolves that lease via ctx (open-Q#2, NOT process.env)
 *                                          and drives real `xdotool` / `import` on the leased display.
 *
 * This is the regression guard for the bug the plan's open-Q#2 named: a fleet bee's
 * capability:computer call runs in the OPERATOR process (its MCP → /api/mcp), so the
 * bee's spawn-env never reaches the handler — the display MUST come from the in-process
 * hive lease keyed by ctx.harnessSlug. The test sets NO display env, proving resolution
 * is purely ctx → lease.
 *
 * GUARDED: runs ONLY when PAPERCUSP_COMPUTER_LIVE=1 AND the X tooling is present, so a
 * normal `test:affected` / CI run (no opt-in, often no X) SKIPS it. To run it on a box
 * with X:
 *   PAPERCUSP_COMPUTER_LIVE=1 npx vitest run lib/agent-tools/computer/computer-live.test.ts
 */
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runComputerAction } from './computer';
import { ensureHiveDesktop, releaseHiveDesktop } from './desktop-lease';

const HIVE = 'computer-live-proof';
const PNG_MAGIC = '89504e470d0a1a0a';

function hasBin(bin: string): boolean {
  try {
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const liveEnabled =
  process.env.PAPERCUSP_COMPUTER_LIVE === '1' &&
  ['Xvfb', 'xdotool', 'import', 'xdpyinfo', 'openbox'].every(hasBin);

/** Where the X server says the pointer actually is — X's answer, not ours. */
function mouseLocation(display: string): { x: number; y: number } {
  const r = spawnSync('xdotool', ['getmouselocation', '--shell'], {
    env: { ...process.env, DISPLAY: display },
    timeout: 30_000,
  });
  const out = r.stdout.toString();
  const num = (k: string) => Number.parseInt(new RegExp(`^${k}=(\\d+)$`, 'm').exec(out)?.[1] ?? 'NaN', 10);
  return { x: num('X'), y: num('Y') };
}

/** Wall-clock cost of one raw xdotool invocation, SIGKILLed if it runs away. */
function timeXdotool(display: string, args: string[]): { ms: number; status: number | null } {
  const t0 = Date.now();
  const r = spawnSync('xdotool', args, {
    env: { ...process.env, DISPLAY: display },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { ms: Date.now() - t0, status: r.status };
}

describe.skipIf(!liveEnabled)('capability:computer — LIVE desktop drive (real Xvfb)', () => {
  afterAll(async () => {
    await releaseHiveDesktop(HIVE);
  });

  it('leases a real desktop and drives it through ctx.harnessSlug end-to-end', async () => {
    // Belt-and-suspenders: no display env at all → resolution can ONLY come from the lease.
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    delete process.env.PAPERCUSP_AGENT_DISPLAY;

    const d = await ensureHiveDesktop(HIVE);
    expect(d.number).toBeGreaterThan(0); // a real sandbox display, NEVER host :0
    expect(d.display).not.toBe(':0');

    const shoot = async () => {
      const r = await runComputerAction({ action: 'screenshot' }, { harnessSlug: HIVE });
      const img = r.content.find((c) => c.type === 'image') as { data: string } | undefined;
      expect(img).toBeTruthy();
      const buf = Buffer.from(img!.data, 'base64');
      expect(buf.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC); // a genuine PNG every time
      return buf;
    };

    // 1. CAPTURE: screenshot resolved PURELY from the hive lease via ctx (no env) → a real
    //    PNG of the leased Xvfb. A fresh root is uniform black → PNG-compresses to ~233 bytes,
    //    which itself proves capture+resolution work (real display, not :0, not a stub).
    const buf1 = await shoot();
    expect(buf1.length).toBeGreaterThan(50);

    // 2. LIVE: change the leased screen deterministically (paint a pattern on the SAME display
    //    the tool resolved), then re-capture. The two frames MUST differ → the tool sees the
    //    live screen state, not a cached/wrong-display frame. A patterned root is non-uniform
    //    → a meaningfully larger PNG than the blank baseline.
    const paint = spawnSync('xsetroot', ['-display', d.display, '-mod', '4', '4', '-fg', 'navy', '-bg', 'white']);
    expect(paint.status).toBe(0);
    const buf2 = await shoot();
    expect(buf2.equals(buf1)).toBe(false); // the screen changed → genuinely live capture
    expect(buf2.length).toBeGreaterThan(300); // captured the rendered pattern, not the blank root

    // 3. INPUT: drive xdotool through the tool against the leased display → a non-error result
    //    with a fresh auto-screenshot. Proves the eyes (capture) AND hands (input) both bind to
    //    the ctx-resolved sandbox display.
    const acted = await runComputerAction(
      { action: 'left_click', coordinate: [200, 200] },
      { harnessSlug: HIVE },
    );
    expect(acted.isError).toBeFalsy();
    const img3 = acted.content.find((c) => c.type === 'image') as { data: string } | undefined;
    expect(img3).toBeTruthy();
    expect(Buffer.from(img3!.data, 'base64').subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
  }, 30_000);

  // ── D-014 / EI-21256574817493619 ────────────────────────────────────────────
  // THE DEFECT: `xdotool mousemove --sync X Y` takes ~15.2s when the pointer is
  // ALREADY at (X,Y) and a window manager is running. computer.ts SIGKILLs at
  // EXEC_TIMEOUT_MS=15_000, so we killed xdotool mid-sync and the CHAINED `click 1`
  // never ran — clicking the same button twice cost 15s and reported FAILED.
  // THE FIX: a 1px interior nudge before every synced move, so the sync is never a
  // no-op. `--sync` is KEPT, because its guarantee (on return the pointer IS at the
  // target) is what the next action depends on.
  //
  // ⚠ THIS TEST CARRIES ITS OWN POSITIVE CONTROL, and that is the point. Asserting
  // only "the fix is fast" is vacuous: if openbox were not running, or a future
  // xdotool no longer had the pathology, the subject would be fast for reasons that
  // have nothing to do with the nudge and the green would mean nothing. So the
  // control re-runs the EXACT un-nudged argv this fix replaced and REQUIRES it to be
  // slow. If the control ever goes fast, this test fails loudly and tells you to
  // re-check whether the defect still exists — which is the honest outcome, not a
  // silent pass.
  it('D-014: repeating the same coordinate is fast — and the un-nudged shape it replaced is NOT', async () => {
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    delete process.env.PAPERCUSP_AGENT_DISPLAY;

    const d = await ensureHiveDesktop(HIVE);
    const CTL: [number, number] = [300, 300]; // display-space, for the raw control

    // CONTROL step 1 — prime: pointer is elsewhere, so this synced move is the FAST
    // case and establishes that a synced move is cheap when it actually has to move.
    const primed = timeXdotool(d.display, ['mousemove', '--sync', String(CTL[0]), String(CTL[1])]);
    expect(primed.status).toBe(0);
    expect(primed.ms).toBeLessThan(5_000);

    // CONTROL step 2 — the pathology: the identical un-nudged argv, now a no-op sync.
    // This is the exact shape planAction emitted before D-014.
    const control = timeXdotool(d.display, [
      'mousemove', '--sync', String(CTL[0]), String(CTL[1]), 'click', '1',
    ]);
    expect(control.ms).toBeGreaterThan(5_000); // the environment DOES reproduce the defect

    // SUBJECT — the same coordinate clicked TWICE through the real tool path. Before
    // D-014 the second call took ~15s and came back isError. `isError` falsy is itself
    // the proof the click FIRED: the chained `click 1` only runs if the whole xdotool
    // invocation survived to exit 0 instead of being SIGKILLed mid-`--sync`.
    const XY: [number, number] = [400, 300];
    const t1 = Date.now();
    const first = await runComputerAction(
      { action: 'left_click', coordinate: XY, observe: 'none' },
      { harnessSlug: HIVE },
    );
    const firstMs = Date.now() - t1;
    const posAfterFirst = mouseLocation(d.display);

    const t2 = Date.now();
    const second = await runComputerAction(
      { action: 'left_click', coordinate: XY, observe: 'none' },
      { harnessSlug: HIVE },
    );
    const secondMs = Date.now() - t2;
    const posAfterSecond = mouseLocation(d.display);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    // WELL under the 15s SIGKILL — not merely under it, or we would be re-asserting
    // the timeout rather than the fix.
    expect(firstMs).toBeLessThan(5_000);
    expect(secondMs).toBeLessThan(5_000);

    // The nudge's OWN hazard, pinned: a 1px pre-move that failed to land back on the
    // target would leave the pointer one pixel off and silently mis-aim every
    // subsequent click. `--sync` is what forbids that, so assert X's own answer —
    // and assert it is UNCHANGED by the repeat, which is the property the nudge must
    // not have broken.
    expect(posAfterSecond).toEqual(posAfterFirst);
    expect(Number.isFinite(posAfterFirst.x)).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[D-014] control(un-nudged, same spot) ${control.ms}ms · primed(moving) ${primed.ms}ms · ` +
        `subject click#1 ${firstMs}ms click#2 ${secondMs}ms · pointer ${posAfterSecond.x},${posAfterSecond.y}`,
    );
  }, 120_000);
});
