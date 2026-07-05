// @vitest-environment node
/**
 * psu-pty-host-turn.integration.test.ts — the REAL managed-pty CONTROL-SOCKET
 * turn path (coordination-test-suite-2026-06-08 P-004, C1+C2 real-seam).
 *
 * The sibling psu-pty-host.integration.test.ts covers raw-mode inject + the
 * force-interrupt leg. This file covers the THREE uncovered seams:
 *   (C2) mode:'turn' = the idle-gated CR-SUBMIT path — a wake turn is submitted
 *        as a full line (data + '\r'), not the immediate, no-newline raw write —
 *        reached via the REAL operator discovery handshake (findLiveHost →
 *        injectIntoHost), the exact chain the wake-executor uses.
 *   (C2) the idle gate itself — a turn defers while the user is typing and lands
 *        once the input line goes quiet (P-013 mid-keystroke safety).
 *   (C1) cross-agent socket isolation (EI-153 class) — a wake addressed to
 *        ownerId A can NEVER reach ownerId B's session; their sockets are
 *        distinct and an inject into A's socket touches only A's child.
 *
 * Spawns real @lydell/node-pty subprocesses + binds real UNIX sockets under the
 * REAL ~/.papercusp/psu-pty dir, so it's an integration test. UNIQUE ownerIds
 * (pid + perf-now + suffix) keep it from ever colliding with the live fleet, and
 * each test asserts its socket+meta are removed on child exit.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import {
  hostThroughPty,
  socketPathFor,
  metaPathFor,
} from '../scripts/psu-pty-host.mjs';
// The REAL operator-side discovery + inject seam (operator-core published
// subpath). Importing it keeps this an integration test of the actual chain a
// wake takes, not a re-implementation of the wire protocol.
import {
  findLiveHost,
  injectIntoHost,
  PSU_PTY_DIR,
} from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// WI-2339 defect #2 (2026-07-04) added a process-IDENTITY check to findLiveHost:
// the discovered pid's /proc/<pid>/cmdline must match /psu-(launcher|pty-host)/,
// so a recycled pid held by an unrelated process can't masquerade as a live host.
// This test hosts the pty IN-PROCESS (hostThroughPty runs inside the vitest
// worker, which records `pid: process.pid` — the WORKER's own pid, whose
// cmdline is the vitest runner, not a psu-launcher/psu-pty-host process), so
// every bare findLiveHost() call here fails that check post-WI-2339 even
// though the discovered host is a perfectly valid stand-in for this test.
// psu-pty-discovery.test.ts's own `ID_OK` seam is the documented fix for
// exactly this (see findLiveHost's doc comment: "A test writing `process.pid`
// as a live-host stand-in injects `() => true`") — mirror it here.
const ID_OK = { verifyIdentity: () => true } as const;

/** Poll findLiveHost until the just-booted host's discovery file is visible, instead
 *  of a single check after a fixed sleep. A flat `await sleep(400)` occasionally isn't
 *  enough once several real @lydell/node-pty children have already booted earlier in
 *  the same run (this file's tests execute back-to-back and share the box's CPU/IO) —
 *  observed as an intermittent `findLiveHost` null on the LAST test only under
 *  full-file load, never in isolation. Resolves as soon as the host is discoverable
 *  (usually the first poll) or null once `timeoutMs` elapses. */
async function waitForHost(
  ownerId: string,
  timeoutMs = 2000,
): ReturnType<typeof findLiveHost> extends infer T ? Promise<T> : never {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const host = findLiveHost(ownerId, PSU_PTY_DIR, ID_OK);
    if (host || Date.now() >= deadline) return host;
    await sleep(25);
  }
}

/** A unique ownerId so we never collide with a live fleet session. */
function uniqueOwner(suffix: string): string {
  return `su-turn-itest-${process.pid}-${Math.floor(performance.now())}-${suffix}`;
}

/** EI-7662 (residual, post-hermeticEnv): poll `capturedFn()` until it contains
 *  `substr`, instead of injecting the instant `waitForHost` resolves.
 *  `hostThroughPty` writes the discovery meta file SYNCHRONOUSLY right after
 *  `pty.spawn()` — well before the freshly-spawned child's own node runtime has
 *  initialized (a bare `node -e` child measurably takes 100ms+ to emit its first
 *  byte on this box, more under fleet-wide load — see the EI-7662 completion
 *  note). So `waitForHost` resolving is NOT evidence the child has started being
 *  "busy" or has reached a `setRawMode(true)` call: a test that injects right
 *  after it races ahead of the child, DETERMINISTICALLY (not flakily — the gap
 *  is wide and consistent) missing the busy-gate / raw-mode-armed
 *  paste-detection windows these tests exist to exercise. The 3 tests below
 *  each wait for a genuine readiness signal from the child before injecting.
 *  Resolves true once `substr` is seen, false at `timeoutMs`. */
async function waitForOutput(
  capturedFn: () => string,
  substr: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (capturedFn().includes(substr)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(15);
  }
}

/** `process.env` with the PAPERCUSP_FLEET_* vars stripped, so this test is hermetic
 *  to whether the AGENT RUNNING IT happens to be a fleet member. `hostThroughPty`
 *  emits a fleet-recolor OSC banner (fleetOscFromEnv, psu-pty-host.mjs) to the
 *  child's stdout whenever `PAPERCUSP_FLEET_BG` is set — a plain `...process.env`
 *  spread inherits it from whatever shell runs the test, so this whole file passed
 *  cleanly from a non-fleet dev shell but genuinely failed (captured() polluted with
 *  literal OSC bytes ahead of the child's own output) when run from inside an su
 *  fleet-member session (PAPERCUSP_FLEET_BG/_FG/_CURSOR set by bootstrap-su for the
 *  fleet's bound color scheme) — exactly the environment backlog-drain agents run
 *  `npm run test:affected` in, which is almost certainly why the watchdog saw this
 *  file red repeatedly. */
function hermeticEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const {
    PAPERCUSP_FLEET_BG: _bg,
    PAPERCUSP_FLEET_FG: _fg,
    PAPERCUSP_FLEET_CURSOR: _cursor,
    ...rest
  } = process.env;
  return { ...rest, ...extra };
}

/** A fake stdout that accumulates the pty's output; a non-TTY fake stdin.
 *  Mirrors the sibling file's fakeIo() — bridgeTty defaults OFF here, so an
 *  injected turn is NOT idle-gated (gate only runs when the TTY is bridged). */
function fakeIo() {
  let captured = '';
  return {
    captured: () => captured,
    io: {
      stdout: {
        columns: 80,
        rows: 24,
        write: (d: Buffer | string) => {
          captured += d.toString();
        },
        on() {},
        off() {},
      },
      stdin: { isTTY: false, on() {}, off() {}, resume() {}, pause() {} },
    },
  };
}

/** A fake io whose stdin is an EventEmitter so a test can drive keystroke
 *  activity (emit 'data'); setRawMode present so bridgeTty can be turned ON,
 *  which is what arms the host-side idle gate for a 'turn' inject. */
function bridgedIo() {
  let captured = '';
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    resume() {},
    pause() {},
    setRawMode() {},
  });
  return {
    captured: () => captured,
    type: (s: string) => stdin.emit('data', Buffer.from(s, 'utf8')),
    io: {
      stdout: {
        columns: 80,
        rows: 24,
        write: (d: Buffer | string) => {
          captured += d.toString();
        },
        on() {},
        off() {},
      },
      stdin,
    },
  };
}

/** Child that echoes "ECHO:<line>" per newline-terminated stdin line, then
 *  self-exits after `ttlMs` so the test can't hang. */
function echoChildCode(ttlMs: number): string {
  return (
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
    `setTimeout(()=>process.exit(0),${ttlMs});`
  );
}

/** A child that models the Claude Code TUI's PASTE detector (the naive echoChild
 *  does NOT): a CR is a SUBMIT only when it arrives as its OWN read, >W ms after
 *  the previous bytes. A CR riding in the SAME chunk as bulk text is a paste — a
 *  literal newline, NO submit. So a one-shot `text\r` burst (the PRE-FIX host
 *  behavior) never submits; the host's split (text … then a lone CR after a
 *  settle) does. Emits "SUBMIT:<buffer>" on a real submit; self-exits after ttlMs. */
function pasteAwareChildCode(ttlMs: number, pasteWindowMs: number): string {
  // RAW mode is essential: the real TUI puts the pty in raw mode and does its own
  // line editing/paste detection. Without it the pty's canonical line discipline
  // buffers input until a newline and delivers a whole line in one read — which
  // hides the very split (text … then a lone CR) this test exists to prove. Raw
  // mode also disables ICRNL (so a CR stays '\r') and ECHO (so stdout carries
  // only our SUBMIT line, not the input echo).
  return (
    "let b='';let last=0;const W=" + pasteWindowMs + ";" +
    "try{process.stdin.setRawMode&&process.stdin.setRawMode(true);}catch(e){}" +
    "process.stdin.setEncoding('utf8');process.stdin.resume();" +
    // EI-7662: an explicit readiness marker — written to stdout directly (not
    // input-echo, so raw-mode state doesn't affect it) the instant raw mode is
    // armed + the listener attached. Without this the test has no way to know
    // the child has reached setRawMode(true) before injecting, and races it
    // (host writes land while the pty is still in canonical+echo mode).
    "process.stdout.write('READY\\n');" +
    "process.stdin.on('data',s=>{" +
    "const now=Date.now();const gap=now-last;last=now;" +
    "if((s==='\\r'||s==='\\n')&&gap>W){process.stdout.write('SUBMIT:'+b+'\\n');b='';}" +
    "else{b+=s.replace(/[\\r\\n]/g,'\\u23ce');}" +
    "});" +
    `setTimeout(()=>process.exit(0),${ttlMs});`
  );
}

/** A child that models a MID-TURN agent: it writes a '.' to stdout every
 *  `intervalMs` (a generating TUI repaints constantly) for `busyMs`, then goes
 *  QUIET (back at its prompt). It also echoes 'ECHO:<line>' per newline-terminated
 *  stdin line, so a CR-submitted wake turn is observable. Self-exits after ttlMs.
 *  The output stream is what the host's mid-turn gate watches. */
function busyThenIdleChildCode(busyMs: number, intervalMs: number, ttlMs: number): string {
  return (
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
    `const iv=setInterval(()=>process.stdout.write('.'),${intervalMs});` +
    `setTimeout(()=>clearInterval(iv),${busyMs});` +
    `setTimeout(()=>process.exit(0),${ttlMs});`
  );
}

describe('psu-pty-host mode:turn CR-submit via the real discovery handshake (C2)', () => {
  it(
    'discovers the live host by ownerId, injects a turn, and the child reads it as a SUBMITTED line',
    async () => {
      const ownerId = uniqueOwner('A');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(3500)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // Fast, deterministic idle gate (not exercised here — bridgeTty off —
          // but set for consistency with the gating test).
          PAPERCUSP_PSU_PTY_IDLE_MS: '120',
        },
        ownerId,
        advSessionId: 4243,
        io,
        bridgeTty: false,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      // The REAL discovery handshake the wake-executor uses. Poll (not a flat sleep)
      // so this doesn't flake under full-file load — see waitForHost's doc comment.
      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();
      // Socket + meta created on start.
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);

      expect(host!.ownerId).toBe(ownerId);
      expect(host!.sock).toBe(sock);

      // Inject a wake TURN through the discovered socket. mode:'turn' appends the
      // CR — so the echo child (which only emits a line on '\n') will print it.
      // A raw inject would NOT append the newline, so the child would stay silent;
      // seeing ECHO: proves the turn was CR-SUBMITTED as a full line.
      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'wake-turn-A' });
      expect(ok).toBe(true);

      await sleep(600);
      expect(captured()).toContain('ECHO:wake-turn-A');

      // Let the child self-exit; the host resolves with its code.
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);

      // Cleaned up on exit.
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host idle gate defers a turn while busy, submits once idle (C2 / P-013)', () => {
  it(
    'a turn injected during a keystroke burst does NOT land until typing stops + the idle window elapses',
    async () => {
      // The host-side idle gate only engages when bridgeTty is true (a 'turn'
      // inject is gated only on a bridged TTY — see psu-pty-host.mjs: the
      // `bridgeTty && msg.gated` guard). So drive this through a bridged EE stdin.
      const idleMs = 250;
      const ownerId = uniqueOwner('IDLE');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, type, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(6000)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: String(idleMs),
          PAPERCUSP_PSU_PTY_IDLE_CAP_MS: '8000',
          // Keep the NEW mid-turn (output-quiescence) gate short here — this test
          // exercises the HUMAN-keystroke gate; the echo child is output-quiet once
          // typing stops, so a tiny window lets the turn land within the window
          // this test already waits (coord-wake-mid-turn-2026-06-30).
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '120',
        },
        ownerId,
        advSessionId: 9999,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      
      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      // Keep the input line "busy": emit keystroke activity every 60ms. Each
      // touch() resets the gate's idle clock, so a turn injected now must wait.
      // The typed chars carry NO newline (bridgeTty:true forwards them into the
      // child's stdin, where they buffer without flushing) — so while busy the
      // child emits NO line at all. The only thing that can produce a newline is
      // the gated wake turn (which appends a CR). Thus "any ECHO: line" is a
      // precise proxy for "the gated turn has been submitted".
      let typing = true;
      (async () => {
        while (typing) {
          type('x'); // a bare keystroke; resets idle, buffers in the child, no flush
          await sleep(60);
        }
      })();

      // Inject the wake turn WHILE busy.
      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'gated-wake' });
      expect(ok).toBe(true);

      // Mid-burst (well under idleMs after the last keystroke): the turn has NOT
      // landed yet — the gate is holding its CR behind the active input line, so
      // NO line has been flushed to the child's echoer.
      await sleep(400);
      expect(captured()).not.toContain('ECHO:');

      // Stop typing; after idleMs + margin of quiet, the gate releases and the
      // turn is written (CR-submitted), flushing the buffered line. The buffered
      // keystrokes prefix it (xxx…gated-wake) — what matters is that a CR-flushed
      // echoed line carrying the wake's data appears only AFTER the idle window.
      typing = false;
      await sleep(idleMs + 900);
      expect(captured()).toMatch(/ECHO:x*gated-wake/);

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host mid-turn inject safety: a turn DEFERS until the agent is at its prompt (coord-wake-mid-turn-2026-06-30)', () => {
  it(
    'a wake turn injected while the agent is MID-TURN (emitting) does NOT land until output goes quiet (back at prompt)',
    async () => {
      // The exact multi-recipient-broadcast hang: a wake landing on a busy TUI
      // wedges the turn (needs ESC). The fix holds the inject until the agent's pty
      // output has been quiet (it returned to its prompt). bridgeTty:true arms the
      // gates; we never type, so the HUMAN idle gate is instantly satisfied and the
      // AGENT-busy gate is the only thing holding the inject.
      const ownerId = uniqueOwner('MIDTURN');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        // Busy (emitting '.') for 900ms, then quiet; self-exits at 4000ms.
        args: ['-e', busyThenIdleChildCode(900, 50, 4000)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: '60', // human gate satisfied fast (we don't type)
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200', // inject once output quiet 200ms
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000', // generous — the agent DOES go quiet
        },
        ownerId,
        advSessionId: 8881,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

       // host up; child still busy emitting
      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      // EI-7662: wait for the child to have GENUINELY started emitting (its
      // first '.') before injecting — otherwise this races the child's own
      // node-startup latency (100ms+) and injects while `lastOutputAt` is
      // still its pre-first-output default, which the busy gate treats as
      // "at prompt" (see makeAgentBusyGate's doc comment), letting the write
      // through immediately instead of exercising the hold-until-quiet path.
      expect(await waitForOutput(captured, '.')).toBe(true);

      // Inject the wake turn WHILE the agent is mid-turn (still emitting '.').
      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'midturn-wake' });
      expect(ok).toBe(true);

      // Still within the busy window (child emits until ~900ms) → the turn is HELD,
      // never written into the busy TUI. No ECHO of the wake line yet.
      await sleep(350);
      expect(captured()).not.toContain('ECHO:midturn-wake');

      // After the agent goes quiet (≥900ms) + the 200ms output-quiet window, the
      // gate releases and the turn is CR-submitted — a CLEAN re-invoke once the
      // turn ended, with no wedge / no ESC.
      await sleep(900);
      expect(captured()).toContain('ECHO:midturn-wake');

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'an agent that stays busy past the cap DROPS the live inject (never wedges the turn) — the durable inbox stands',
    async () => {
      // The anti-wedge guarantee: if the agent never returns to its prompt within
      // the cap, the host DROPS the live inject rather than write into the busy
      // turn. The wake message is already durably in the inbox (seen next turn).
      const ownerId = uniqueOwner('CAPDROP');
      const sock = socketPathFor(ownerId);
      const { captured, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        // Busy for the WHOLE life of the child (emits until it exits at 2500ms).
        args: ['-e', busyThenIdleChildCode(2500, 50, 2500)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: '60',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150', // never reached (emits every 50ms)
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300', // short cap → defer/drop fast
        },
        ownerId,
        advSessionId: 8882,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });


      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      // EI-7662: wait for genuine busy activity before injecting — see the
      // comment on the sibling MID-TURN test above; same node-startup race.
      expect(await waitForOutput(captured, '.')).toBe(true);

      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'dropped-wake' });
      expect(ok).toBe(true);

      // Well past the 300ms cap: the inject was DROPPED (agent never went quiet) —
      // the wake line was NEVER written into the busy turn, so the child never
      // echoes it. No wedge could occur because nothing was injected.
      await sleep(1200);
      expect(captured()).not.toContain('ECHO:dropped-wake');

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host cross-agent socket isolation (C1 / EI-153 class)', () => {
  it(
    'a turn addressed to A can never reach B: distinct sockets, inject touches only A',
    async () => {
      const ownerA = uniqueOwner('ISO-A');
      const ownerB = uniqueOwner('ISO-B');
      const sockA = socketPathFor(ownerA);
      const sockB = socketPathFor(ownerB);
      const metaA = metaPathFor(ownerA);
      const metaB = metaPathFor(ownerB);
      const a = fakeIo();
      const b = fakeIo();

      const baseEnv = (id: string) => ({
        ...hermeticEnv(),
        PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_SID: id,
        TERM: 'xterm-256color',
        PAPERCUSP_PSU_PTY_IDLE_MS: '120',
      });

      const doneA = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(4000)],
        cwd: '/tmp',
        env: baseEnv(ownerA),
        ownerId: ownerA,
        advSessionId: 1,
        io: a.io,
        bridgeTty: false,
        onExit: () => {},
      });
      const doneB = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(4000)],
        cwd: '/tmp',
        env: baseEnv(ownerB),
        ownerId: ownerB,
        advSessionId: 2,
        io: b.io,
        bridgeTty: false,
        onExit: () => {},
      });

      // Both discoverable, with DISTINCT sockets — the isolation boundary.
      const hostA = await waitForHost(ownerA);
      const hostB = await waitForHost(ownerB);
      expect(hostA).not.toBeNull();
      expect(hostB).not.toBeNull();
      expect(hostA!.sock).not.toBe(hostB!.sock);
      expect(hostA!.sock).toBe(sockA);
      expect(hostB!.sock).toBe(sockB);

      // Wake ONLY A.
      const ok = await injectIntoHost(hostA!.sock, { mode: 'turn', data: 'only-for-A' });
      expect(ok).toBe(true);
      await sleep(700);

      // A's child saw it; B's child NEVER did — a wake for A cannot cross to B.
      expect(a.captured()).toContain('ECHO:only-for-A');
      expect(b.captured()).not.toContain('only-for-A');

      await Promise.all([doneA, doneB]);

      // Both cleaned up independently.
      expect(existsSync(sockA)).toBe(false);
      expect(existsSync(sockB)).toBe(false);
      expect(existsSync(metaA)).toBe(false);
      expect(existsSync(metaB)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host dead-host discovery rejection (self-validating)', () => {
  it(
    'findLiveHost returns null once the host has exited (socket gone / pid dead)',
    async () => {
      const ownerId = uniqueOwner('DEAD');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      const done = hostThroughPty({
        command: execPath,
        // Shortest-lived child: exit almost immediately.
        args: ['-e', 'setTimeout(()=>process.exit(0),300);'],
        cwd: '/tmp',
        env: hermeticEnv({ PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' }),
        ownerId,
        advSessionId: 7,
        io,
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(150);
      // Alive mid-flight → discoverable.
      expect(findLiveHost(ownerId, PSU_PTY_DIR, ID_OK)).not.toBeNull();

      // After exit, the discovery file + socket are removed and findLiveHost is null.
      await done;
      await sleep(100);
      expect(findLiveHost(ownerId, PSU_PTY_DIR, ID_OK)).toBeNull();
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host turn SUBMITS because the CR is a SEPARATE keystroke (paste-detector regression)', () => {
  it(
    'a paste-aware child (models the Claude Code TUI) receives a SUBMITTED turn — the pre-fix one-shot text+CR burst would NOT have submitted',
    async () => {
      const ownerId = uniqueOwner('PASTE');
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', pasteAwareChildCode(4000, 40)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // Host sends the submit CR 120ms after the text — well past the child's
          // 40ms paste window, so the lone CR registers as a real Enter. A one-shot
          // `text+CR` burst (the pre-fix behavior) would land INSIDE the window and
          // be swallowed as a literal newline → no submit.
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '120',
        },
        ownerId,
        advSessionId: 4244,
        io,
        bridgeTty: false,
        onExit: (c: number) => {
          exitCode = c;
        },
      });


      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      // EI-7662: wait for the child's explicit READY marker (written right
      // after it arms raw mode) before injecting — otherwise the host's text
      // write can land while the pty is still in default canonical+echo mode
      // (node -e startup to reach setRawMode(true) is measurably 100ms+ on
      // this box), producing raw echoed input instead of exercising the
      // paste-aware child's own gap-based submit detection.
      expect(await waitForOutput(captured, 'READY')).toBe(true);

      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'paste-then-enter' });
      expect(ok).toBe(true);

      // Wait past the 120ms CR delay for the separate Enter to land + submit.
      await sleep(700);
      expect(captured()).toContain('SUBMIT:paste-then-enter');

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
    },
    20_000,
  );
});
