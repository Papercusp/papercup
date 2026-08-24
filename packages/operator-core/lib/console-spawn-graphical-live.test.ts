/**
 * Opt-in graphical regression for WI-40182 / EI-21350530547250762.
 *
 * The fast console-spawn suite proves the job-control boundary through a real
 * pseudo-terminal. This test adds the missing graphical boundary: a real X
 * terminal maps a window, receives Ctrl+C while the greeting owns the
 * foreground process group, and remains usable afterward.
 *
 * The fixture is deliberately isolated from the owner's desktop. It creates a
 * private Xvfb + Openbox display and drives only the window on that display.
 * Follow-up command text is pasted through X PRIMARY selection rather than
 * `xdotool type`, whose keymap-dependent character synthesis can corrupt text
 * or leak it into a different live window.
 *
 * Run explicitly:
 *   PAPERCUSP_TERMINAL_GRAPHICAL_LIVE=1 \
 *     npx vitest run lib/console-spawn-graphical-live.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConsoleOneliner, type AppearanceOpts } from './console-spawn';

function hasBin(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore', timeout: 10_000 }).status === 0;
}

const liveEnabled =
  process.env.PAPERCUSP_TERMINAL_GRAPHICAL_LIVE === '1' &&
  ['Xvfb', 'xdpyinfo', 'openbox', 'xterm', 'xdotool', 'xclip'].every(hasBin);

const APPEARANCE: AppearanceOpts = { mode: 'console', planSlug: null, label: null };

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch {
      // The display/window may still be coming up. Retry until the shared deadline.
    }
    await sleep(50);
  }
  return false;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await eventually(() => child.exitCode !== null || child.signalCode !== null, 2_000)) return;
  child.kill('SIGKILL');
  await eventually(() => child.exitCode !== null || child.signalCode !== null, 2_000);
}

async function startPrivateXvfb(): Promise<{ child: ChildProcess; display: string }> {
  // Xvfb's own display lock is the final arbiter. Try a high, process-rotated
  // range so concurrent live tests converge without deleting anybody else's
  // lock/socket or assuming a fixed display is free.
  const first = 220 + (process.pid % 300);
  for (let offset = 0; offset < 120; offset += 1) {
    const number = 220 + ((first - 220 + offset) % 300);
    const display = `:${number}`;
    const child = spawn('Xvfb', [display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    const ready = await eventually(() => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return spawnSync('xdpyinfo', ['-display', display], {
        stdio: 'ignore',
        timeout: 2_000,
      }).status === 0;
    }, 2_500);
    if (ready) return { child, display };
    await stopChild(child);
  }
  throw new Error('could not reserve a private Xvfb display for the terminal smoke');
}

function xdotool(display: string, args: string[]): string {
  const result = spawnSync('xdotool', args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: display },
    timeout: 10_000,
  });
  expect(
    result.status,
    `xdotool ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
  ).toBe(0);
  return result.stdout.trim();
}

describe.skipIf(!liveEnabled)('console spawn — LIVE graphical Ctrl+C survival', () => {
  let dir = '';
  let display = '';
  let xvfb: ChildProcess | null = null;
  let openbox: ChildProcess | null = null;
  let terminal: ChildProcess | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'papercusp-console-graphical-'));
    const started = await startPrivateXvfb();
    xvfb = started.child;
    display = started.display;
    openbox = spawn('openbox', [], {
      env: { ...process.env, DISPLAY: display },
      stdio: 'ignore',
    });
    expect(await eventually(() => openbox?.exitCode === null, 1_000)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await stopChild(terminal);
    await stopChild(openbox);
    await stopChild(xvfb);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the mapped terminal usable after Ctrl+C interrupts its foreground greeting', async () => {
    const greetingMarker = join(dir, 'greeting-started');
    const survivalMarker = join(dir, 'terminal-survived');
    const label = `ctrl-c-graphical-${process.pid}-${Date.now()}`;
    const expectedTitle = `SH: ${label}`;
    const appearance: AppearanceOpts = { ...APPEARANCE, label };
    const greeting = `printf GREETING_STARTED > ${shq(greetingMarker)}; sleep 30`;
    const oneLiner = buildConsoleOneliner(
      dir,
      { SHELL: '/bin/bash', PS1: 'PAPERCUSP-SURVIVED> ' },
      greeting,
      appearance,
    );

    terminal = spawn(
      'xterm',
      ['-T', expectedTitle, '-e', 'bash', '--noprofile', '--norc', '-lc', oneLiner],
      {
        env: { ...process.env, DISPLAY: display },
        stdio: 'ignore',
      },
    );

    let windowId = '';
    const greetingRunning = await eventually(() => {
      const found = spawnSync('xdotool', ['search', '--onlyvisible', '--name', expectedTitle], {
        encoding: 'utf8',
        env: { ...process.env, DISPLAY: display },
        timeout: 2_000,
      });
      windowId = found.status === 0 ? found.stdout.trim().split(/\s+/)[0] ?? '' : '';
      return Boolean(windowId) && existsSync(greetingMarker);
    }, 10_000);
    expect(greetingRunning, 'the isolated terminal never mapped or started its greeting').toBe(true);
    expect(readFileSync(greetingMarker, 'utf8')).toBe('GREETING_STARTED');
    expect(terminal.exitCode).toBeNull();

    // Focus changes are safe here because this is a private Xvfb with exactly
    // one test window; the owner's :0/:1 session is not addressable from it.
    xdotool(display, ['windowactivate', '--sync', windowId]);
    xdotool(display, ['key', '--clearmodifiers', 'ctrl+c']);
    await sleep(250);

    // xterm's exact-text paste channel is PRIMARY + Shift+Insert. Never use
    // `xdotool type`: it synthesizes characters through the active keymap and
    // was the source of EI-21350530547250762's misleading smoke commands.
    const followUp = `printf TERMINAL_SURVIVED_SIGINT > ${shq(survivalMarker)}`;
    const clip = spawnSync('xclip', ['-selection', 'primary', '-in'], {
      input: followUp,
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: display },
      timeout: 10_000,
    });
    expect(clip.status, `xclip failed: ${clip.stderr}`).toBe(0);
    xdotool(display, ['key', '--clearmodifiers', 'shift+Insert']);
    xdotool(display, ['key', 'Return']);

    expect(
      await eventually(() => existsSync(survivalMarker), 5_000),
      'the post-Ctrl+C command never ran in the surviving terminal',
    ).toBe(true);
    expect(readFileSync(survivalMarker, 'utf8')).toBe('TERMINAL_SURVIVED_SIGINT');
    expect(xdotool(display, ['getwindowname', windowId])).toBe(expectedTitle);
    expect(terminal.exitCode).toBeNull();

    xdotool(display, ['windowclose', windowId]);
    expect(await eventually(() => terminal?.exitCode !== null || terminal?.signalCode !== null, 5_000)).toBe(true);
    terminal = null;
  }, 30_000);
});
