/**
 * desktop-driver.test.ts — unit coverage for the pure computer-use driver:
 * action→xdotool argv mapping, the host-display safety guard, coordinate
 * clamping, and the capture command. No live display required.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSandboxDisplay,
  planAction,
  captureCommand,
  xdotoolCommand,
  type DesktopTarget,
} from './desktop-driver';

const T: DesktopTarget = { display: ':99', width: 1024, height: 768 };

describe('assertSandboxDisplay — never the host :0', () => {
  it('accepts a sandbox display', () => {
    expect(() => assertSandboxDisplay(':99')).not.toThrow();
    expect(() => assertSandboxDisplay(':1')).not.toThrow();
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
