// @vitest-environment node
/**
 * psu-pty-host.integration.test.ts — the real managed-pty round-trip
 * (turn-lifecycle-control Phase 3, P-012/P-014/P-015): spawn a child through the
 * host, inject via the control socket, assert it lands in the child's stdin, and
 * assert the socket + discovery file are created on start and cleaned up on exit.
 * Spawns a real @lydell/node-pty subprocess, so it's an integration test.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import {
  hostThroughPty,
  socketPathFor,
  metaPathFor,
  encodeControl,
} from '../scripts/psu-pty-host.mjs';
// The REAL operator-side force-interrupt leg (turn-lifecycle-control Phase 4
// pty-force, reused by e8630's turn:interrupt tool). Importing the published
// subpath keeps this an integration test of the actual chain, not a re-impl.
import { interruptViaPty, findLiveHost } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

/** A fake stdout that accumulates the pty's output; a non-TTY fake stdin. */
function fakeIo() {
  let captured = '';
  return {
    captured: () => captured,
    io: {
      stdout: { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} },
      stdin: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
    },
  };
}

function rawInject(sock: string, data: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'raw', data }));
      c.end();
    });
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

function controlInject(sock: string, mode: 'turn' | 'raw' | 'osc' | 'reset' | 'recycle', data: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode, data }));
      c.end();
    });
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hostThroughPty real round-trip', () => {
  it(
    'creates socket+meta on start, injects into the live child, cleans up on exit',
    async () => {
      const ownerId = `su-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // Child reads stdin, echoes "ECHO:<line>" per newline-terminated line, then
      // exits after a bounded window so the test can't hang.
      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),3000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 4242,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(400);
      // Created on start
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      expect(m.ownerId).toBe(ownerId);
      expect(m.advSessionId).toBe('4242');
      expect(m.sock).toBe(sock);
      expect(typeof m.pid).toBe('number');

      // Inject a line via the control socket → the child reads it from stdin.
      await rawInject(sock, 'hello-wake\n');
      await sleep(500);
      expect(captured()).toContain('ECHO:hello-wake');

      // Let the child's own timeout end it; wait for host resolution.
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);

      // Cleaned up on exit
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('RECYCLE — kill + respawn the child in the same host (su-cold-auto-mode P-004b)', () => {
  it(
    'replaces the child process, keeps the host (socket/meta) alive, and opens the fresh process on the carry-note',
    async () => {
      const ownerId = `su-recycle-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // Child prints BOOT:<pid> once on start, echoes stdin lines, exits on QUIT
      // (or a 15s safety net). The per-boot pid marker lets us prove the process
      // was actually replaced by the recycle, not just re-injected.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // Speed the post-respawn carry inject: the fresh child's boot output goes
          // quiet fast, so a short output-quiet window lets the carry land promptly.
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(600);
      const bootsBefore = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      expect(bootsBefore).toHaveLength(1); // exactly one child so far
      const pid1 = bootsBefore[0];
      const ptyPid1 = JSON.parse(readFileSync(meta, 'utf8')).ptyPid;
      expect(ptyPid1).toBe(pid1);

      // RECYCLE with a carry-note. The host kills the child, fresh-spawns it in the
      // SAME host (same socket/meta/SID), and opens the fresh process on the carry.
      await controlInject(sock, 'recycle', 'CARRIED');
      await sleep(2500); // kill + respawn + boot + output-quiet(200) + submit CR

      const bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      expect(bootsAfter).toHaveLength(2); // the child was actually respawned
      const pid2 = bootsAfter[1];
      expect(pid2).not.toBe(pid1); // a genuinely new process
      // The carry-note was injected as the opening turn of the fresh context.
      expect(captured()).toContain('ECHO:CARRIED');

      // The HOST survived the recycle: socket + meta still live, meta now points at
      // the fresh child's pid (same host pid, new ptyPid).
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);
      const metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      expect(metaAfter.ownerId).toBe(ownerId);
      expect(metaAfter.ptyPid).toBe(pid2);

      // End the fresh child → the host tears down and cleans up (not before).
      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

describe('RECYCLE respawns with FRESH session args + re-anchors identity (WI-1980 seam)', () => {
  it(
    'feeds the child the mintRecycleArgs-rewritten argv, fires onRespawn once with the fresh native id, and keeps the coord identity env unchanged',
    async () => {
      const ownerId = `su-recycle-args-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // Child prints, once on boot, its LAST argv marker + the PAPERCUSP_SID env:
      // the ARGV marker proves WHICH argv the respawn used (rewritten vs original),
      // the SID marker proves the coord identity env survived the recycle unchanged.
      // Exits on QUIT (15s safety net).
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+' ARGV:'+process.argv[process.argv.length-1]+' SID:'+(process.env.PAPERCUSP_SID||'')+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const FRESH_NATIVE = 'ffffabcd-1234-5678-9abc-def012345678';
      const mintCalls: string[][] = [];
      const respawns: string[] = [];

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        // WI-1980 seam: rewrite the respawn argv (swap the trailing marker so we can
        // prove the FRESH args are what the respawned child ran) and hand back a fresh
        // native id so the host re-anchors it via onRespawn.
        mintRecycleArgs: (a: string[]) => {
          mintCalls.push(a);
          return { args: a.slice(0, -1).concat('RECYCLED'), nativeId: FRESH_NATIVE };
        },
        onRespawn: (nativeId: string) => { respawns.push(nativeId); },
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(600);
      expect(captured()).toContain('ARGV:ORIGINAL'); // first boot used the launch argv verbatim

      // RECYCLE (no carry — we're testing the respawn argv/identity, not carry inject).
      await controlInject(sock, 'recycle', '');
      await sleep(2500); // kill + respawn + boot

      // The respawn ran the REWRITTEN argv (proves spawnChild(recycleArgs) wiring)…
      expect(captured()).toContain('ARGV:RECYCLED');
      // …mintRecycleArgs was handed the ORIGINAL launch args, exactly once…
      expect(mintCalls).toHaveLength(1);
      expect(mintCalls[0]).toEqual(['-e', childCode, 'ORIGINAL']);
      // …onRespawn fired exactly once with the fresh native id (the re-anchor hook)…
      expect(respawns).toEqual([FRESH_NATIVE]);
      // …and PAPERCUSP_SID (coord identity, D-003) was IDENTICAL across both boots.
      const sids = [...captured().matchAll(/SID:(\S+)/g)].map((m) => m[1]);
      expect(sids).toEqual([ownerId, ownerId]);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

describe('force interrupt via the operator-side interruptViaPty (Phase 4 pty-force leg)', () => {
  it(
    'lands a real SIGINT mid-run through the control socket; the shell survives',
    async () => {
      // The full live chain: a managed-pty session is hosting a real bash with a
      // long foreground job ("the agent mid-thinking"); the operator calls
      // interruptViaPty(owner,'sigint') — discover the session by ownerId → connect
      // to its control socket → inject a RAW Ctrl-C → the pty line discipline turns
      // it into SIGINT for the foreground process group. NOT the user's keyboard,
      // NOT the stdin bridge — the same path e8630's turn:interrupt force mode uses.
      let captured = '';
      const stdout = { columns: 100, rows: 40, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {}, setRawMode() {} });
      const type = (s: string) => (stdin as EventEmitter).emit('data', Buffer.from(s, 'utf8'));

      const ownerId = `su-force-itest-${process.pid}-${Math.floor(performance.now())}`;
      const done = hostThroughPty({
        command: 'bash',
        args: ['--norc', '--noprofile', '-i'],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color', PS1: '$ ' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(500);
      // The operator can discover the live session (same lookup the wake-executor uses).
      expect(findLiveHost(ownerId)).not.toBeNull();

      // Start a 20s foreground job. If the interrupt FAILS, the typed `exit` queues
      // behind it and this test blows its 15s timeout — so a clean finish is itself
      // evidence the sleep was cut short.
      type('sleep 20\n');
      await sleep(600);

      const ok = await interruptViaPty(ownerId, 'sigint');
      expect(ok).toBe(true);
      await sleep(500);

      // Shell survived the interrupt and accepts a new command.
      type('echo SURVIVED_FORCE\n');
      await sleep(500);
      type('exit\n');
      await done;

      expect(captured).toContain('^C'); // the foreground job got SIGINT
      expect(captured).toContain('SURVIVED_FORCE'); // shell still alive afterward

      // Cleanup
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    15_000,
  );
});
