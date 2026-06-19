/**
 * computer.test.ts — capability:computer handler (runComputerAction) with an
 * injected exec seam: verifies the image ToolResult shape, display binding,
 * auto-screenshot-after-action, and the safety refusals (no lease / host :0).
 * No live X server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runComputerAction,
  __setComputerExecForTests,
  __resetComputerExec,
  type ComputerExec,
} from './computer';
import {
  ensureHiveDesktop,
  releaseAllHiveDesktops,
  __setProvisionerForTests,
  __resetProvisioner,
} from './desktop-lease';

/** A fake leased desktop on a sandbox display — no live Xvfb. */
function fakeLease(display: string, width = 1024, height = 768) {
  return { display, number: Number(display.slice(1)), width, height, release: async () => {} };
}

/** A minimal valid PNG (magic + padding) so the capture passes the magic check. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

interface Call {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

function recordingExec(): { exec: ComputerExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ComputerExec = async (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env });
    if (bin === 'import') return { status: 0, stdout: PNG, stderr: '' };
    if (bin === 'xdotool' && args[0] === 'getmouselocation') {
      return { status: 0, stdout: Buffer.from('X=400 Y=300 SCREEN=0 WINDOW=1'), stderr: '' };
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  return { exec, calls };
}

describe('runComputerAction — capability:computer handler', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_COMPUTER_DISPLAY = ':99';
  });
  afterEach(async () => {
    __resetComputerExec();
    await releaseAllHiveDesktops();
    __resetProvisioner();
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    delete process.env.PAPERCUSP_COMPUTER_WIDTH;
    delete process.env.PAPERCUSP_COMPUTER_HEIGHT;
    delete process.env.PAPERCUSP_AGENT_DISPLAY;
  });

  it('screenshot → a single image content block (base64 PNG)', async () => {
    const { exec } = recordingExec();
    __setComputerExecForTests(exec);
    const r = await runComputerAction({ action: 'screenshot' });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect((r.content[0] as { data: string }).data).toBe(PNG.toString('base64'));
  });

  it('left_click → drives xdotool with DISPLAY bound, then auto-screenshots', async () => {
    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    const r = await runComputerAction({ action: 'left_click', coordinate: [400, 300] });

    const xd = calls.find((c) => c.bin === 'xdotool');
    expect(xd?.env).toEqual({ DISPLAY: ':99' }); // bound to the sandbox, never :0
    expect(xd?.args).toEqual(['mousemove', '--sync', '400', '300', 'click', '1']);

    // returns a confirmation + the post-action screenshot the bee reasons over
    expect(r.content.some((c) => c.type === 'text')).toBe(true);
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('cursor_position → text only (no screenshot)', async () => {
    const { exec } = recordingExec();
    __setComputerExecForTests(exec);
    const r = await runComputerAction({ action: 'cursor_position' });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('X=400');
  });

  it('refuses loudly when no desktop is leased', async () => {
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    __setComputerExecForTests(recordingExec().exec);
    await expect(runComputerAction({ action: 'screenshot' })).rejects.toThrow(/no sandbox desktop is leased/);
  });

  it('refuses the host display :0', async () => {
    process.env.PAPERCUSP_COMPUTER_DISPLAY = ':0';
    __setComputerExecForTests(recordingExec().exec);
    await expect(runComputerAction({ action: 'screenshot' })).rejects.toThrow(/HOST display :0/);
  });

  it('surfaces an xdotool failure as isError', async () => {
    const exec: ComputerExec = async (bin) =>
      bin === 'import'
        ? { status: 0, stdout: PNG, stderr: '' }
        : { status: 1, stdout: Buffer.alloc(0), stderr: 'boom' };
    __setComputerExecForTests(exec);
    const r = await runComputerAction({ action: 'left_click', coordinate: [1, 2] });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/failed/);
  });

  it('honors a custom leased resolution for coordinate clamping', async () => {
    process.env.PAPERCUSP_COMPUTER_WIDTH = '800';
    process.env.PAPERCUSP_COMPUTER_HEIGHT = '600';
    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'mouse_move', coordinate: [99999, 99999] });
    const xd = calls.find((c) => c.bin === 'xdotool');
    expect(xd?.args).toEqual(['mousemove', '--sync', '799', '599']); // clamped to 800x600
  });

  // open-Q#2: the handler runs in the OPERATOR process (a fleet bee's call lands at
  // /api/mcp), so it CANNOT read the bee's spawn-env. It must resolve the caller's hive
  // desktop from ctx.harnessSlug against the in-process lease Map.
  it('resolves the caller hive in-process lease via ctx.harnessSlug (no env needed)', async () => {
    __setProvisionerForTests(async () => fakeLease(':150', 1280, 720));
    await ensureHiveDesktop('demo-hive');
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY; // prove the display comes from the lease, not env

    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'left_click', coordinate: [10, 20] }, { harnessSlug: 'demo-hive' });

    const xd = calls.find((c) => c.bin === 'xdotool');
    expect(xd?.env).toEqual({ DISPLAY: ':150' }); // the hive's leased sandbox display
    const cap = calls.find((c) => c.bin === 'import');
    expect(cap?.args.some((a) => a.includes(':150'))).toBe(true); // capture bound to the lease too
  });

  it('the caller hive lease takes priority over a stray process.env display', async () => {
    process.env.PAPERCUSP_COMPUTER_DISPLAY = ':99'; // set by beforeEach — a different display
    __setProvisionerForTests(async () => fakeLease(':151'));
    await ensureHiveDesktop('hive-a');

    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'mouse_move', coordinate: [5, 5] }, { harnessSlug: 'hive-a' });

    const xd = calls.find((c) => c.bin === 'xdotool');
    expect(xd?.env).toEqual({ DISPLAY: ':151' }); // ctx hive lease wins, NOT env :99
  });

  it('falls back to the frame per-slot marker PAPERCUSP_AGENT_DISPLAY when no hive lease', async () => {
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
    process.env.PAPERCUSP_AGENT_DISPLAY = ':7'; // a desktop-frame leased slot (acquireAgentDisplay)

    const { exec, calls } = recordingExec();
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'left_click', coordinate: [1, 1] }, { harnessSlug: 'no-lease-hive' });

    const xd = calls.find((c) => c.bin === 'xdotool');
    expect(xd?.env).toEqual({ DISPLAY: ':7' });
  });
});
