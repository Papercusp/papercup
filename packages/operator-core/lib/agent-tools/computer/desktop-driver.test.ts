/**
 * desktop-driver.test.ts — unit coverage for the pure computer-use driver:
 * action→xdotool argv mapping, the host-display safety guard, coordinate
 * clamping, and the capture command. No live display required.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSandboxDisplay,
  captureFit,
  planAction,
  captureCommand,
  sandboxXEnv,
  stripHostX,
  toCaptureCoord,
  xdotoolCommand,
  type DesktopTarget,
} from './desktop-driver';

const T: DesktopTarget = { display: ':99', width: 1024, height: 768 };

describe('assertSandboxDisplay — never the host :0', () => {
  it('accepts a sandbox display', () => {
    // WI-1318: env-agnostic — assertSandboxDisplay also refuses whatever display
    // process.env.DISPLAY currently points at (the operator's real seat, which on
    // some runners IS :1), so this test must pin DISPLAY to a known value rather
    // than assume the ambient host display number. Mirrors the ISOLATION describe
    // block below (save/restore around a controlled DISPLAY).
    const saved = process.env.DISPLAY;
    process.env.DISPLAY = ':0'; // any fixed value distinct from the displays asserted below
    try {
      expect(() => assertSandboxDisplay(':99')).not.toThrow();
      expect(() => assertSandboxDisplay(':1')).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = saved;
    }
  });
  it.each([':0', ':0.0'])('REFUSES the host display %s', (d) => {
    expect(() => assertSandboxDisplay(d)).toThrow(/HOST display :0/);
  });
  it.each(['', '  ', '99', 'localhost:0', ':abc'])('rejects the malformed display %p', (d) => {
    expect(() => assertSandboxDisplay(d)).toThrow(/invalid display/);
  });
});

describe('planAction — canonical action → xdotool argv', () => {
  it('screenshot / cursor_position / wait are non-xdotool plans', () => {
    expect(planAction({ action: 'screenshot' }, T)).toEqual({ kind: 'screenshot' });
    expect(planAction({ action: 'cursor_position' }, T)).toEqual({ kind: 'cursor_position' });
    expect(planAction({ action: 'wait', duration: 2 }, T)).toEqual({ kind: 'wait', ms: 2000 });
  });

  it('wait clamps to 30s', () => {
    expect(planAction({ action: 'wait', duration: 999 }, T)).toEqual({ kind: 'wait', ms: 30000 });
  });

  it('mouse_move → mousemove --sync x y', () => {
    expect(planAction({ action: 'mouse_move', coordinate: [300, 250] }, T)).toEqual({
      kind: 'xdotool',
      args: ['mousemove', '--sync', '300', '250'],
    });
  });

  it('left_click WITH coordinate moves then clicks button 1', () => {
    expect(planAction({ action: 'left_click', coordinate: [10, 20] }, T)).toEqual({
      kind: 'xdotool',
      args: ['mousemove', '--sync', '10', '20', 'click', '1'],
    });
  });

  it('left_click WITHOUT coordinate clicks at the current position', () => {
    expect(planAction({ action: 'left_click' }, T)).toEqual({ kind: 'xdotool', args: ['click', '1'] });
  });

  it('right_click → button 3, middle_click → button 2', () => {
    expect(planAction({ action: 'right_click' }, T).kind).toBe('xdotool');
    expect((planAction({ action: 'right_click' }, T) as { args: string[] }).args).toEqual(['click', '3']);
    expect((planAction({ action: 'middle_click' }, T) as { args: string[] }).args).toEqual(['click', '2']);
  });

  it('double_click → click --repeat 2', () => {
    expect((planAction({ action: 'double_click', coordinate: [5, 5] }, T) as { args: string[] }).args).toEqual([
      'mousemove', '--sync', '5', '5', 'click', '--repeat', '2', '--delay', '120', '1',
    ]);
  });

  it('left_click_drag → mousedown, move, mouseup', () => {
    expect((planAction({ action: 'left_click_drag', coordinate: [100, 200] }, T) as { args: string[] }).args).toEqual([
      'mousedown', '1', 'mousemove', '--sync', '100', '200', 'mouseup', '1',
    ]);
  });

  it('type → type --clearmodifiers -- <text> (the -- stops flag parsing)', () => {
    expect((planAction({ action: 'type', text: '--weird-text' }, T) as { args: string[] }).args).toEqual([
      'type', '--clearmodifiers', '--', '--weird-text',
    ]);
  });

  it('key → key --clearmodifiers -- <chord>', () => {
    expect((planAction({ action: 'key', text: 'ctrl+s' }, T) as { args: string[] }).args).toEqual([
      'key', '--clearmodifiers', '--', 'ctrl+s',
    ]);
  });

  it('scroll down 5 → click --repeat 5 <button 5>', () => {
    expect((planAction({ action: 'scroll', scroll_direction: 'down', scroll_amount: 5 }, T) as { args: string[] }).args).toEqual([
      'click', '--repeat', '5', '5',
    ]);
  });

  it('scroll defaults to down x3', () => {
    expect((planAction({ action: 'scroll' }, T) as { args: string[] }).args).toEqual(['click', '--repeat', '3', '5']);
  });

  it('clamps an out-of-bounds coordinate into the display', () => {
    expect((planAction({ action: 'mouse_move', coordinate: [99999, -50] }, T) as { args: string[] }).args).toEqual([
      'mousemove', '--sync', '1023', '0',
    ]);
  });

  it('throws when a coordinate-requiring action has none', () => {
    expect(() => planAction({ action: 'mouse_move' }, T)).toThrow(/requires a coordinate/);
    expect(() => planAction({ action: 'left_click_drag' }, T)).toThrow(/requires a coordinate/);
  });

  it("throws when 'type' has no text and 'key' has no chord", () => {
    expect(() => planAction({ action: 'type' }, T)).toThrow(/requires text/);
    expect(() => planAction({ action: 'key' }, T)).toThrow(/requires text/);
  });
});

describe('ISOLATION — no agent exec inherits the operator host X session (2026-06-19 leak fix)', () => {
  const saved = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
  afterEach(() => {
    for (const k of ['DISPLAY', 'XAUTHORITY'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('REFUSES the operator host display even when it is NOT :0 (a seat can be :1/:7)', () => {
    process.env.DISPLAY = ':7';
    expect(() => assertSandboxDisplay(':7')).toThrow(/host display :7/);
    // a genuinely provisioned sandbox display still passes
    expect(() => assertSandboxDisplay(':110')).not.toThrow();
  });

  it('stripHostX removes DISPLAY / XAUTHORITY / WAYLAND_DISPLAY, keeps everything else', () => {
    const out = stripHostX({
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      WAYLAND_DISPLAY: 'wayland-0',
      PATH: '/usr/bin',
      HOME: '/home/x',
    } as NodeJS.ProcessEnv);
    expect(out).not.toHaveProperty('DISPLAY');
    expect(out).not.toHaveProperty('XAUTHORITY');
    expect(out).not.toHaveProperty('WAYLAND_DISPLAY');
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
  });

  it('sandboxXEnv binds ONLY the sandbox display + drops the inherited gdm XAUTHORITY', () => {
    const env = sandboxXEnv(':110', undefined, {
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);
    expect(env.DISPLAY).toBe(':110');
    expect(env).not.toHaveProperty('XAUTHORITY'); // the host gdm cookie never reaches the child
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sandboxXEnv refuses :0 / the host display', () => {
    expect(() => sandboxXEnv(':0')).toThrow(/HOST display :0/);
  });

  it('sandboxXEnv attaches a sandbox-owned XAUTHORITY when given (access-controlled sandbox)', () => {
    const env = sandboxXEnv(':110', '/tmp/sandbox-110.Xauth', { PATH: '/usr/bin' } as NodeJS.ProcessEnv);
    expect(env.XAUTHORITY).toBe('/tmp/sandbox-110.Xauth');
    expect(env.DISPLAY).toBe(':110');
  });
});

describe('command builders bind the sandbox display and refuse :0', () => {
  it('captureCommand → import against the display, png to stdout', () => {
    expect(captureCommand(T)).toEqual({ bin: 'import', args: ['-display', ':99', '-silent', '-window', 'root', 'png:-'] });
  });
  it('captureCommand refuses :0', () => {
    expect(() => captureCommand({ ...T, display: ':0' })).toThrow(/HOST display :0/);
  });
  it('xdotoolCommand binds DISPLAY to the sandbox', () => {
    const plan = planAction({ action: 'left_click', coordinate: [1, 2] }, T) as { kind: 'xdotool'; args: string[] };
    expect(xdotoolCommand(plan, T)).toEqual({ bin: 'xdotool', args: plan.args, env: { DISPLAY: ':99' } });
  });
  it('xdotoolCommand refuses :0', () => {
    const plan = planAction({ action: 'left_click' }, T) as { kind: 'xdotool'; args: string[] };
    expect(() => xdotoolCommand(plan, { ...T, display: ':0' })).toThrow(/HOST display :0/);
  });
});

/**
 * D-006 (plan agent-virtual-desktops-2026-08-23, P-006 / WI-40890) — two geometries.
 *
 * The display is what X runs at; the capture box is what the MODEL is served. These
 * pin the three properties that make a downscaled capture SAFE rather than silently
 * wrong — each MEASURED against ImageMagick 6.9.12 on the box before being encoded:
 *
 *   1. shrink-only (a smaller display is never magnified — that RAISES the bill)
 *   2. aspect-preserving, so ONE scale factor maps both axes
 *   3. coordinate round-tripping, so a click lands where the model aimed it
 */
describe('D-006 capture geometry', () => {
  const FRAME: DesktopTarget = {
    display: ':99',
    width: 1920,
    height: 1080,
    capture: { width: 1024, height: 768 },
  };

  describe('captureFit', () => {
    it('shrinks 1920x1080 into the box PRESERVING ASPECT — 1024x576, not 1024x768', () => {
      // The box is a BOUNDING box. Asserting 1024x768 would encode a squashed image
      // ImageMagick never produces: measured `-resize '1024x768>'` → 1024x576.
      expect(captureFit(FRAME)).toEqual({ width: 1024, height: 576, scale: 1024 / 1920 });
    });

    it('NEVER magnifies a display smaller than the box', () => {
      // The trap: `-resize 1024x768` (no `>`) turns 800x600 into 1024x768 — a token
      // INCREASE from a change whose entire purpose is to cut cost.
      const small: DesktopTarget = { display: ':99', width: 800, height: 600, capture: { width: 1024, height: 768 } };
      expect(captureFit(small)).toEqual({ width: 800, height: 600, scale: 1 });
    });

    it('is identity when no capture box is set', () => {
      expect(captureFit(T)).toEqual({ width: 1024, height: 768, scale: 1 });
    });

    it('scales on the MORE constrained axis (an ultrawide is bound by width)', () => {
      const ultrawide: DesktopTarget = { display: ':99', width: 3440, height: 1440, capture: { width: 1024, height: 768 } };
      const fit = captureFit(ultrawide);
      expect(fit.scale).toBeCloseTo(1024 / 3440, 10);
      expect(fit).toMatchObject({ width: 1024, height: 429 });
    });

    it('never rounds an axis down to a zero-pixel image', () => {
      const sliver: DesktopTarget = { display: ':99', width: 4000, height: 3, capture: { width: 100, height: 100 } };
      expect(captureFit(sliver).height).toBeGreaterThanOrEqual(1);
    });
  });

  describe('captureCommand', () => {
    it('appends a SHRINK-ONLY resize when the display exceeds the box', () => {
      expect(captureCommand(FRAME).args).toEqual([
        '-display', ':99', '-silent', '-window', 'root', '-resize', '1024x768>', 'png:-',
      ]);
    });

    it('omits the resize entirely when the display already fits', () => {
      expect(captureCommand(T).args).not.toContain('-resize');
    });
  });

  describe('coordinate mapping', () => {
    it('maps a capture-space click into DISPLAY space', () => {
      // The model saw a 1024x576 image and clicked (1000, 500); on the real 1920x1080
      // display that is (1875, 938). Without the mapping the click lands at (1000, 500)
      // — roughly half-way up and left of where the model aimed.
      const plan = planAction({ action: 'left_click', coordinate: [1000, 500] }, FRAME) as { args: string[] };
      expect(plan.args).toEqual(['mousemove', '--sync', '1875', '938', 'click', '1']);
    });

    it('clamps in CAPTURE space, so the image corner reaches the SCREEN corner', () => {
      // The regression this pins: width/height once carried the CAPTURE size while the
      // screenshot stayed full-size, so coord() clamped every click to 1023x767 and the
      // bottom-right ~72% of a 1920x1080 frame was unreachable.
      const plan = planAction({ action: 'left_click', coordinate: [99999, 99999] }, FRAME) as { args: string[] };
      const [x, y] = [Number(plan.args[2]), Number(plan.args[3])];

      // Lands in the LAST capture pixel, which covers display columns 1918-1919 (and
      // rows 1078-1079). Asserting an exact 1919x1079 would be over-specifying: capture
      // pixel 1023 maps to 1918.125, and every display pixel it covers shows the same
      // averaged content, so 1918 and 1919 are the same click as far as any UI target
      // is concerned. What must hold is that the corner is REACHABLE.
      expect(x).toBeGreaterThanOrEqual(1918);
      expect(x).toBeLessThanOrEqual(1919);
      expect(y).toBeGreaterThanOrEqual(1078);
      expect(y).toBeLessThanOrEqual(1079);

      // …and the actual bug, stated as the thing it broke: the old clamp pinned this at
      // 1023x767, leaving most of the screen unclickable.
      expect(x).toBeGreaterThan(1023);
      expect(y).toBeGreaterThan(767);
    });

    it('is unchanged when there is no capture box', () => {
      const plan = planAction({ action: 'mouse_move', coordinate: [300, 250] }, T) as { args: string[] };
      expect(plan.args).toEqual(['mousemove', '--sync', '300', '250']);
    });

    it('round-trips display→capture→display within a scaled pixel', () => {
      // toCaptureCoord is the inverse used by cursor_position. If the two directions
      // disagree, the pointer the model is TOLD about is not the one it can click.
      for (const [dx, dy] of [[0, 0], [960, 540], [1919, 1079]] as const) {
        const [cx, cy] = toCaptureCoord(dx, dy, FRAME);
        const plan = planAction({ action: 'mouse_move', coordinate: [cx, cy] }, FRAME) as { args: string[] };
        expect(Math.abs(Number(plan.args[2]) - dx)).toBeLessThanOrEqual(2);
        expect(Math.abs(Number(plan.args[3]) - dy)).toBeLessThanOrEqual(2);
      }
    });
  });
});
