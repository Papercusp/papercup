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
});
