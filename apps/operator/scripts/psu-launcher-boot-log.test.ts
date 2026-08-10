/**
 * psu-launcher-boot-log.test.ts — WI-37841.
 *
 * A HUD "+ New session" launch that dies before psu registers used to leave NO
 * readable evidence: psu prints the reason into the spawned window's pty and
 * nothing else, so the operator could only ever report "its terminal closed
 * before the session came online". That single sentence has cost two full
 * forensic sessions for two different root causes — both of which psu had
 * already printed.
 *
 * `installBootLogCapture` is the fix's writer half. The tests below pin the four
 * properties that make it safe to run on every programmatic launch: it captures,
 * it is bounded, it NEVER interferes with what the window shows, and it cannot
 * fail the launch it is diagnosing.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-boot-log.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { installBootLogCapture } from './psu-launcher.mjs';
import {
  psuLaunchLogPath,
  readPsuLaunchLogTail,
} from '../../../packages/operator-core/lib/psu-launch-log.mjs';

const OWNER = 'su-b053c5b3-8059-4a12-b17f-8225a3dcb6a4';

let home: string;
/** A stand-in for process.stderr that records what the WINDOW would have seen. */
let seen: string[];
let stream: Writable & { write: (c: any, e?: any, cb?: any) => boolean };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'psu-boot-log-'));
  seen = [];
  stream = { write: (c: any) => (seen.push(String(c)), true) } as any;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const install = (owner: string | null = OWNER, opts: Record<string, unknown> = {}) =>
  installBootLogCapture(owner, { home, stream, argv: ['--no-picker', '--agent=claude'], ...opts });

describe('installBootLogCapture — the writer half (WI-37841)', () => {
  it('WRITES WHERE THE READER READS — the agreement, proven by execution', () => {
    // THE load-bearing invariant of this feature. Nothing at runtime fails if the
    // two sides drift: psu would log faithfully to a path nobody reads, and the
    // banner would report "no diagnostic" while the diagnostic sat on disk —
    // indistinguishable from the bug we are fixing. A source-text check that both
    // files mention the shared module cannot see this; running both can.
    const handle = install()!;
    expect(handle.path).toBe(psuLaunchLogPath(OWNER, { home }));

    stream.write('psu: refusing to boot — the reason\n');
    handle.uninstall();

    expect(readPsuLaunchLogTail(OWNER, { home })).toContain('psu: refusing to boot — the reason');
  });

  it('records the argv header — what a failed launch was ASKED to do', () => {
    // Not recoverable afterwards: a launch that dies leaves an adv_sessions row
    // with no session_id, and the argv is what separates "psu refused these
    // arguments" from "psu never got that far".
    const handle = install()!;
    handle.uninstall();
    const log = readFileSync(handle.path, 'utf8');
    expect(log).toContain(`# psu launch ${OWNER} at `);
    expect(log).toContain('# argv: --no-picker --agent=claude');
  });

  it('still writes through to the real stream — the window must be unchanged', () => {
    // This is a TEE, not a redirect. If capture ever swallowed a line, it would
    // remove the diagnostic from the one place that has always shown it, making
    // the launch HARDER to debug for a human sitting at the window.
    const handle = install()!;
    stream.write('line one\n');
    stream.write('line two\n');
    handle.uninstall();
    expect(seen).toEqual(['line one\n', 'line two\n']);
  });

  it('restores the original write on uninstall', () => {
    const original = stream.write;
    const handle = install()!;
    expect(stream.write).not.toBe(original);
    handle.uninstall();
    expect(stream.write).toBe(original);
  });

  it('is BOUNDED — a chatty session cannot grow the log without limit', () => {
    // Capture rides a long-lived process. Without a cap, a healthy session that
    // logs for hours would fill the disk to produce a file no one ever reads.
    const handle = install(OWNER, { maxBytes: 64 })!;
    stream.write('x'.repeat(10_000));
    handle.uninstall();
    // header + at most the cap
    expect(readFileSync(handle.path, 'utf8').length).toBeLessThanOrEqual(64);
  });

  it('keeps writing to the WINDOW after the cap is reached', () => {
    // The cap bounds the FILE, never the user-visible stream — truncating what
    // the window shows would be a regression caused purely by diagnostics.
    const handle = install(OWNER, { maxBytes: 16 })!;
    stream.write('a'.repeat(100));
    stream.write('after the cap\n');
    handle.uninstall();
    expect(seen).toContain('after the cap\n');
  });

  it('TRUNCATES, so a reader is never handed a previous launch\'s diagnostic', () => {
    // Owner ids are minted per launch, so a pre-existing file here means a reused
    // id or a stale artifact. Reporting yesterday's reason for today's failure is
    // worse than reporting none — it is a confident wrong answer.
    const path = psuLaunchLogPath(OWNER, { home })!;
    mkdirSync(join(home, '.papercusp', 'psu-launch-logs'), { recursive: true });
    writeFileSync(path, 'STALE DIAGNOSTIC FROM AN EARLIER LAUNCH\n');
    const handle = install()!;
    stream.write('fresh\n');
    handle.uninstall();
    const log = readFileSync(path, 'utf8');
    expect(log).not.toContain('STALE DIAGNOSTIC');
    expect(log).toContain('fresh');
  });

  it('captures a non-string chunk (a Buffer) — console.error is not the only writer', () => {
    const handle = install()!;
    stream.write(Buffer.from('buffered diagnostic\n', 'utf8'));
    handle.uninstall();
    expect(readFileSync(handle.path, 'utf8')).toContain('buffered diagnostic');
  });

  describe('a diagnostic side-channel must never be able to fail a launch', () => {
    it('returns null (and captures nothing) for an owner id it will not path-ify', () => {
      // Also the security boundary: the id becomes a path segment.
      for (const bad of ['../../../../etc/passwd', 'su abc', '', null]) {
        expect(install(bad as string | null)).toBeNull();
      }
    });

    it('returns null — never throws — when the log cannot be opened', () => {
      // A DIRECTORY where the log file should be: openSync throws EISDIR.
      mkdirSync(psuLaunchLogPath(OWNER, { home })!, { recursive: true });
      expect(() => install()).not.toThrow();
      expect(install()).toBeNull();
    });

    it('leaves the stream untouched when it declines to capture', () => {
      // The failure mode this rules out: a half-installed tee that wrapped the
      // stream and then gave up, so every later write goes through dead code.
      const original = stream.write;
      install(null);
      expect(stream.write).toBe(original);
    });

    it('keeps the window working even if the file write starts failing mid-launch', () => {
      const handle = install()!;
      rmSync(home, { recursive: true, force: true }); // yank the fd's directory
      expect(() => stream.write('after the disk went away\n')).not.toThrow();
      expect(seen).toContain('after the disk went away\n');
      handle.uninstall();
    });
  });

  it('does not capture for a launch with no pre-pinned owner (a human at a terminal)', () => {
    // Scope limit, by construction: only a PROGRAMMATIC launch carries
    // --owner-id. A human typing `psu` has the window in front of them.
    expect(install(null)).toBeNull();
    expect(existsSync(join(home, '.papercusp', 'psu-launch-logs'))).toBe(false);
  });
});
