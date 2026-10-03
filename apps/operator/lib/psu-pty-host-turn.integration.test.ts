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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostThroughPty,
  socketPathFor,
  metaPathFor,
  eventLogPathForOwner,
  KICKOFF_PROOF_PATH_ENV,
  KICKOFF_PROOF_TOKEN_ENV,
} from '../scripts/psu-pty-host.mjs';
// The REAL operator-side discovery + inject seam (operator-core published
// subpath). Importing it keeps this an integration test of the actual chain a
// wake takes, not a re-implementation of the wire protocol.
import {
  findLiveHost,
  injectIntoHost,
  injectIntoHostWithConfirmation,
  PSU_PTY_DIR,
} from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Child startup is a different lifecycle from post-submit observation. The
// host discovery file is written before the spawned Node runtime emits its
// first byte, and that gap has exceeded waitForOutput's tight 3s delivery
// default in full-file runs. Keep readiness explicit instead of weakening the
// delivery assertions that use the default below.
const CHILD_START_OUTPUT_TIMEOUT_MS = 10_000;

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

it('re-armed wake uses its verified native boundary without a second busy-gate wait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-rearm-boundary-'));
  const sessions = join(root, 'sessions', '2026', '09', '24');
  mkdirSync(sessions, { recursive: true });
  const transcript = join(sessions, 'rollout-rearm.jsonl');
  const ownerId = uniqueOwner('REARM-BOUNDARY');
  const sock = socketPathFor(ownerId);
  const log = eventLogPathForOwner(ownerId);
  const { io, captured } = fakeIo();
  const childCode = [
    "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
    "process.stdout.write('READY\\n');setInterval(()=>process.stdout.write('REPAINT\\n'),10);",
    "let line='';process.stdin.on('data',data=>{for(const c of data){",
    "if(c==='\\u0004'){process.exit(0);return;}",
    "if(c==='\\r'){if(line){process.stdout.write('ECHO:'+line+'\\n');line='';}}else{line+=c;}}});",
    'setTimeout(()=>process.exit(0),10000);',
  ].join('');
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', childCode],
    cwd: root,
    env: hermeticEnv({
      PAPERCUSP_SID: ownerId,
      PAPERCUSP_AGENT: 'codex',
      CODEX_HOME: root,
      PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '150',
      PAPERCUSP_PSU_PTY_REARM_CAP_MS: '1200',
      PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '120',
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '500',
      PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '10',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '1',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
    }),
    ownerId,
    io,
    bridgeTty: false,
    onExit: () => {},
  });
  try {
    expect(await waitForHost(ownerId)).not.toBeNull();
    expect(await waitForOutput(captured, 'REPAINT', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);
    const accepted = await injectIntoHostWithConfirmation(sock, {
      mode: 'turn', ownerId, data: 'REARM_PROOF', deliveryId: 'rearm-proof-1',
    });
    expect(accepted).toMatchObject({ ok: true, confirmation: 'acked', reason: 'accepted' });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(existsSync(log) && readFileSync(log, 'utf8').includes('"kind":"wake-rearm-queued"'))) {
      await sleep(20);
    }
    expect(readFileSync(log, 'utf8')).toContain('"kind":"wake-rearm-queued"');
    writeFileSync(transcript, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'settled-before-rearm' },
    }) + '\n');
    expect(await waitForOutput(captured, 'ECHO:REARM_PROOF', 4000)).toBe(true);
    const terminalDeadline = Date.now() + 2000;
    let events = '';
    while (Date.now() < terminalDeadline) {
      events = readFileSync(log, 'utf8');
      if (events.includes('"kind":"wake-rearm-delivered"')) break;
      await sleep(20);
    }
    expect(events).toContain('"kind":"wake-rearm-delivered"');
    expect(events).not.toContain('"kind":"wake-rearm-dropped"');
  } finally {
    await injectIntoHost(sock, { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
    await done;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it('classifies an interactive Codex capacity wall without retrying or hiding the PTY output', async () => {
  const ownerId = uniqueOwner('MODEL-CAPACITY');
  const sock = socketPathFor(ownerId);
  const { io, captured } = fakeIo();
  let exitCode: number | null = null;
  const done = hostThroughPty({
    command: execPath,
    args: [
      '-e',
      [
        "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
        "let turns=0;process.stdout.write('READY\\n');setTimeout(()=>process.stdout.write('100% context left\\n'),100);",
        "process.stdin.on('data',d=>{if(d.includes('\\x04')){process.exit(0);return;}",
        "if(d.includes('\\r')){turns++;process.stdout.write('Selected model is at capacity. Please try again in 90 seconds.\\n');",
        "process.stdout.write('TURN-COUNT:'+turns+'\\n');}});",
        "setTimeout(()=>process.exit(0),20000);",
      ].join(''),
    ],
    cwd: '/tmp',
    env: hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'codex' }),
    ownerId,
    io,
    bridgeTty: false,
    onExit: (code: number) => { exitCode = code; },
  });
  try {
    expect(await waitForHost(ownerId)).not.toBeNull();
    expect(await waitForOutput(captured, '100% context left', 5000)).toBe(true);
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'trigger-capacity' })).toBe(true);
    expect(await waitForOutput(captured, 'Selected model is at capacity', 5000)).toBe(true);
    expect(await waitForOutput(captured, 'TURN-COUNT:1', 5000)).toBe(true);

    const eventPath = eventLogPathForOwner(ownerId);
    const deadline = Date.now() + 5000;
    let capacityEvent: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !capacityEvent) {
      const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : '';
      for (const line of events.split('\n')) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.kind === 'model-capacity-detected') capacityEvent = event;
        } catch {
          // An append may be observed between the JSON bytes and trailing newline.
        }
      }
      if (!capacityEvent) await sleep(25);
    }
    expect(capacityEvent).toMatchObject({
      kind: 'model-capacity-detected',
      agent: 'codex',
      errorClass: 'rate_limited',
      retryable: true,
      retryAfterMs: 90_000,
      matchedPattern: expect.stringContaining('selected\\s+model'),
      matchedExcerpt: expect.stringContaining('Selected model is at capacity'),
    });
    expect(captured()).not.toContain('TURN-COUNT:2');
    expect(exitCode).toBeNull();
  } finally {
    await injectIntoHost(sock, { mode: 'raw', data: '\x04' }).catch(() => false);
    await done;
  }
  expect(exitCode).toBe(0);
}, 25_000);

describe('Codex carry first turn on a continuously repainting fresh composer', () => {
  it.each(['ready', 'launch-ready', 'terminal-reply', 'owner-input', 'not-ready'] as const)(
    '%s: requires startup proof, preserves owner input, and records actual submission',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'codex-carry-redraw-'));
      const ownerId = uniqueOwner(`CARRY-${scenario}`);
      const nativePath = join(root, 'sessions', '2026', '09', '12', 'rollout-fresh.jsonl');
      mkdirSync(join(root, 'sessions', '2026', '09', '12'), { recursive: true });
      const marker = '⟦turn-origin:self-compaction nonce:1234567890abcdef⟧';
      const proofPath = join(root, 'kickoff-proof.json');
      writeFileSync(proofPath, '', { mode: 0o600 });
      const { captured, io, type } = bridgedIo();
      const freshCode = [
        "const fs=require('node:fs');process.stdin.setRawMode(true);",
        "process.stdout.write('FRESH-BOOT\\n');",
        scenario === 'not-ready' ? '' : "setTimeout(()=>process.stdout.write('100% context left\\n'),150);",
        "setInterval(()=>process.stdout.write('IDLE-REPAINT\\n'),15);",
        // The composer echoes typed text like the real Codex TUI: a fresh launch
        // kickoff is only submitted once its turn-origin marker is visible.
        "let line='';process.stdin.on('data',data=>{let echo='';for(const c of data.toString()){",
        "if(c==='\\u0004')process.exit(0);",
        "if(c==='\\r'){if(line){fs.appendFileSync(process.env.CARRY_NATIVE_PATH,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}})+'\\n');line='';process.stdout.write('SUBMITTED\\n');}}else{line+=c;echo+=c;}}",
        'if(echo)process.stdout.write(echo);});',
        'setTimeout(()=>process.exit(0),4000);',
      ].join('');
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', scenario === 'launch-ready' ? freshCode : "process.stdout.write('OLD-READY\\n');setTimeout(()=>process.exit(0),4000);"],
        kickoff: scenario === 'launch-ready' ? `${marker}\nContinue the saved task` : null,
        cwd: root,
        env: hermeticEnv({
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: root,
          CARRY_NATIVE_PATH: nativePath,
          [KICKOFF_PROOF_PATH_ENV]: proofPath,
          [KICKOFF_PROOF_TOKEN_ENV]: '0123456789abcdef0123456789abcdef0123456789abcdef',
          PAPERCUSP_PSU_PTY_IDLE_MS: '20',
          // not-ready is the one scenario that reaches the ORDINARY busy gate (no startup proof,
          // so the fresh-composer bypass must not fire). With a 60ms quiet window a CPU-starved
          // child that stalls its 15ms repaint for >60ms looks exactly like a prompt, and the
          // carry is (correctly, by the gate's own definition) delivered — observed as a flake
          // at one commit (test_runs 19041094 pass / 19042018 fail). A quiet window LONGER than
          // the busy cap means no single gate attempt can ever see enough silence, so this
          // scenario asserts the proof requirement, not scheduler timing.
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: scenario === 'not-ready' ? '600' : '60',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '250',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '650',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '10',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '200',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
        }),
        ownerId,
        io,
        bridgeTty: true,
        nativePersistenceTimeoutMs: 300,
        mintCarryRespawnArgs: () => ({ args: ['-e', freshCode], nativeId: null }),
        onExit: () => {},
      });
      try {
        if (scenario !== 'launch-ready') {
          expect(await waitForOutput(captured, 'OLD-READY')).toBe(true);
          await injectIntoHost(socketPathFor(ownerId), {
            mode: 'carry-respawn',
            data: `${marker}\nContinue the saved task`,
            systemPromptAddendum: 'saved task',
            ownerId,
          });
        }
        expect(await waitForOutput(captured, 'FRESH-BOOT')).toBe(true);
        if (scenario === 'launch-ready') {
          expect(await waitForOutput(captured, 'SUBMITTED')).toBe(true);
          const deadline = Date.now() + 2000;
          while (!readFileSync(proofPath, 'utf8') && Date.now() < deadline) await sleep(20);
          expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toMatchObject({ persisted: true });
          expect(readFileSync(nativePath, 'utf8').trim().split('\n')).toHaveLength(1);
          return;
        }
        if (scenario === 'terminal-reply') type('\u001b[12;40R');
        if (scenario === 'owner-input') type('owner draft');
        let terminal: Record<string, unknown> | undefined;
        const deadline = Date.now() + 2500;
        while (!terminal && Date.now() < deadline) {
          if (existsSync(eventLogPathForOwner(ownerId))) {
            terminal = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
              .trim().split('\n').map((line) => JSON.parse(line))
              .find((row) => ['respawn-carry-delivered', 'respawn-carry-dropped'].includes(row.kind));
          }
          if (!terminal) await sleep(20);
        }
        if (scenario === 'ready' || scenario === 'terminal-reply') {
          expect(terminal).toMatchObject({ kind: 'respawn-carry-delivered', turnStartVerified: true });
          const turns = readFileSync(nativePath, 'utf8').trim().split('\n');
          expect(turns).toHaveLength(1);
          expect(JSON.parse(turns[0]).payload.content[0].text).toContain(marker);
        } else {
          expect(terminal?.kind).toBe('respawn-carry-dropped');
          expect(existsSync(nativePath)).toBe(false);
          if (scenario === 'owner-input') expect(terminal?.reason).toBe('fresh-child-owner-input');
        }
      } finally {
        await injectIntoHost(socketPathFor(ownerId), { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );
});

it(
  'refreshes a pending Codex carry-respawn from a same-delivery retry before the re-arm commits (EI-24915900486106554)',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-carry-retry-refresh-'));
    const ownerId = uniqueOwner('CARRY-RETRY-REFRESH');
    const sock = socketPathFor(ownerId);
    const eventLog = eventLogPathForOwner(ownerId);
    const { captured, io } = fakeIo();
    const marker = '⟦turn-origin:self-compaction nonce:1234567890abcdef⟧';
    const staleText = `${marker} STALE_CHECKPOINT hash=old age=900s`;
    const freshText = `${marker} FRESH_CHECKPOINT hash=new age=2s`;
    const staleAddendum = 'STALE_CHECKPOINT hash=old age=900s';
    const freshAddendum = 'FRESH_CHECKPOINT hash=new age=2s';
    const originalCode = [
      "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
      "process.stdout.write('OLD-READY\\n');",
      "const repaint=setInterval(()=>process.stdout.write('REPAINT\\n'),10);",
      'setTimeout(()=>clearInterval(repaint),1000);',
      "let line='';process.stdin.on('data',data=>{for(const c of data){",
      "if(c==='\\u0004'){process.exit(0);return;}",
      "if(c==='\\r'){if(line){process.stdout.write('ECHO:'+line+'\\n');line='';}}else{line+=c;}}});",
      'setTimeout(()=>process.exit(0),8000);',
    ].join('');
    const freshCode = [
      "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
      "process.stdout.write('FRESH-BOOT\\n');",
      "let line='';process.stdin.on('data',data=>{for(const c of data){",
      "if(c==='\\u0004'){process.exit(0);return;}",
      "if(c==='\\r'){if(line){process.stdout.write('ECHO:'+line+'\\n');line='';}}else{line+=c;}}});",
      'setTimeout(()=>process.exit(0),5000);',
    ].join('');
    const mintedAddenda: string[] = [];
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', originalCode],
      cwd: root,
      env: hermeticEnv({
        PAPERCUSP_AGENT: 'codex',
        CODEX_HOME: root,
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '120',
        PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '150',
        PAPERCUSP_PSU_PTY_REARM_CAP_MS: '1500',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '700',
        PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '10',
        PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
      }),
      ownerId,
      io,
      bridgeTty: false,
      mintCarryRespawnArgs: (_args, options) => {
        mintedAddenda.push(options.systemPromptAddendum);
        return { args: ['-e', freshCode], nativeId: null };
      },
      onExit: () => {},
    });

    try {
      expect(await waitForHost(ownerId)).not.toBeNull();
      expect(await waitForOutput(captured, 'OLD-READY', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);
      const envelope = {
        mode: 'carry-respawn' as const,
        ownerId,
        deliveryId: 'loop-fire-checkpoint-retry-1',
      };
      expect(await injectIntoHostWithConfirmation(sock, {
        ...envelope,
        data: staleText,
        systemPromptAddendum: staleAddendum,
      })).toMatchObject({ ok: true, reason: 'accepted' });

      const queuedDeadline = Date.now() + 3000;
      let events = '';
      while (Date.now() < queuedDeadline) {
        if (existsSync(eventLog)) {
          events = readFileSync(eventLog, 'utf8');
          if (events.includes('"kind":"respawn-rearm-queued"')) break;
        }
        await sleep(20);
      }
      expect(events).toContain('"kind":"respawn-rearm-queued"');

      expect(await injectIntoHostWithConfirmation(sock, {
        ...envelope,
        data: freshText,
        systemPromptAddendum: freshAddendum,
      })).toMatchObject({ ok: true, reason: 'pending-delivery-id' });
      expect(readFileSync(eventLog, 'utf8')).toContain('"refreshedPendingCarryRespawn":true');

      const respawnDeadline = Date.now() + 5000;
      while (mintedAddenda.length === 0 && Date.now() < respawnDeadline) await sleep(20);
      expect(mintedAddenda).toEqual([freshAddendum]);
      expect(await waitForOutput(captured, `ECHO:${freshText}`, 3000)).toBe(true);
      expect(captured()).not.toContain(`ECHO:${staleText}`);
    } finally {
      if (existsSync(sock)) await injectIntoHost(sock, { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
      await done;
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

describe('host-code-adopted carry with a late Codex native id (WI-10004791)', () => {
  it.each([true, false] as const)(
    'reports and emits only after exact first-turn proof when mapping confirmation is %s',
    async (mappingConfirmed) => {
      const root = mkdtempSync(join(tmpdir(), 'codex-adopted-carry-proof-'));
      const ownerId = uniqueOwner('ADOPTED-CARRY-LATE-ID');
      const nativeId = '12345678-1234-4234-8234-123456789abc';
      const nativePath = join(
        root,
        'sessions',
        '2026',
        '09',
        '12',
        'rollout-2026-09-12T00-00-00-' + nativeId + '.jsonl',
      );
      mkdirSync(join(root, 'sessions', '2026', '09', '12'), { recursive: true });
      const marker = '⟦turn-origin:self-compaction nonce:0011223344556677⟧';
      const kickoff = marker + '\nContinue the adopted carry';
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const order: string[] = [];
      const reportedIds: string[] = [];
      const emitted: Array<{ ownerId: string; focus: string; nativeId: string | null }> = [];
      const childCode = [
        "const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
        "process.stdout.write('FRESH-BOOT\\n');",
        "let line='';process.stdin.on('data',data=>{let echo='';for(const c of data.toString()){",
        "if(c==='\\u0004')process.exit(0);",
        "if(c==='\\r'){if(line){",
        "fs.appendFileSync(process.env.CARRY_NATIVE_PATH,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}})+'\\n');",
        "fs.appendFileSync(process.env.CARRY_NATIVE_PATH,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'adopted-carry'}})+'\\n');",
        "line='';process.stdout.write('SUBMITTED\\n');",
        "}}else{line+=c;echo+=c;}}if(echo)process.stdout.write(echo);});",
        'setTimeout(()=>process.exit(0),8000);',
      ].join('');
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: hermeticEnv({
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_SID: ownerId,
          CODEX_HOME: root,
          CARRY_NATIVE_PATH: nativePath,
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS: '80',
        }),
        ownerId,
        io,
        bridgeTty: false,
        kickoff,
        adoptedCarryRespawn: { nativeId: null },
        nativePersistenceTimeoutMs: 1_000,
        onRespawn: async (freshId: string) => {
          order.push('reanchor');
          reportedIds.push(freshId);
          return mappingConfirmed;
        },
        emitCompacted: (emittedOwner: string, focus: string, options: { nativeId?: string | null }) => {
          order.push('emit');
          emitted.push({ ownerId: emittedOwner, focus, nativeId: options.nativeId ?? null });
          return null;
        },
        onExit: () => {},
      });

      try {
        expect(await waitForOutput(captured, 'FRESH-BOOT', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);
        expect(await waitForOutput(captured, 'SUBMITTED', 5_000)).toBe(true);
        const proofDeadline = Date.now() + 2_000;
        while (!existsSync(nativePath) && Date.now() < proofDeadline) await sleep(20);
        expect(existsSync(nativePath)).toBe(true);

        const terminalDeadline = Date.now() + 2_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < terminalDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            if (events.some((event) =>
              event.kind === 'respawn-carry-delivered' ||
              event.kind === 'respawn-compaction-unannounced')) break;
          }
          await sleep(20);
        }

        expect(reportedIds).toEqual([nativeId]);
        expect(readFileSync(nativePath, 'utf8')).toContain(marker);
        if (mappingConfirmed) {
          const unannounced = events.find((event) => event.kind === 'respawn-compaction-unannounced');
          expect(order, 'unannounced reason=' + String(unannounced?.reason)).toEqual(['reanchor', 'emit']);
          expect(emitted).toEqual([{ ownerId, focus: 'carry-respawn', nativeId }]);
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'respawn-carry-delivered',
            nativeId,
            turnStartVerified: true,
            adopted: true,
          }));
          expect(events).not.toContainEqual(expect.objectContaining({
            kind: 'respawn-compaction-unannounced',
            nativeId,
          }));
        } else {
          expect(order).toEqual(['reanchor']);
          expect(emitted).toHaveLength(0);
          expect(events).toContainEqual(expect.objectContaining({
            kind: 'respawn-compaction-unannounced',
            nativeId,
            reason: 'successor-reanchor-unconfirmed',
            adopted: true,
          }));
        }
      } finally {
        await injectIntoHost(socketPathFor(ownerId), {
          mode: 'raw',
          data: '\\x04',
          ownerId,
        }).catch(() => false);
        await done;
        rmSync(eventLog, { force: true });
        rmSync(metaPathFor(ownerId), { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

it('waits for a headless Codex model-menu repaint before confirming the existing model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-late-model-choice-'));
  const ownerId = uniqueOwner('LATE-MODEL-CHOICE');
  const { captured, io } = fakeIo();
  const childCode = [
    "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
    "process.stdout.write('100% context left\\n› Ask Codex to do anything\\n');",
    "setTimeout(()=>process.stdout.write('Meet GPT-6 Sol\\n› 1. Try new model\\n2. Use existing model\\n'),300);",
    "let selected=false,moving=false,input='';process.stdin.on('data',data=>{input+=data;",
    "if(input.includes('\\u0004'))process.exit(0);",
    "if(!moving&&input.includes('\\u001b[B')){moving=true;input=input.replace('\\u001b[B','');",
    "setTimeout(()=>{selected=true;process.stdout.write('› 2. Use existing model\\n');},50);}",
    "if(input.includes('\\r')){input=input.replace('\\r','');",
    "process.stdout.write(selected?'EXISTING_MODEL_SELECTED\\n':'PREMATURE_CONFIRM\\n');}});",
    'setTimeout(()=>process.exit(0),3000);',
  ].join('');
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', childCode],
    cwd: root,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_PSU_HEADLESS: '1', CODEX_HOME: root }),
    ownerId,
    io,
    bridgeTty: false,
    onExit: () => {},
  });
  try {
    expect(await waitForOutput(captured, 'EXISTING_MODEL_SELECTED', 2500)).toBe(true);
    expect(captured()).not.toContain('PREMATURE_CONFIRM');
    const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
    expect(events).toContain('"kind":"headless-codex-model-choice-kept-existing"');
  } finally {
    await injectIntoHost(socketPathFor(ownerId), { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
    await done;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it('leaves a later Codex model menu to the agent after a turn was submitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-later-model-choice-'));
  const ownerId = uniqueOwner('LATER-MODEL-CHOICE');
  const { captured, io } = fakeIo();
  const childCode = [
    "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
    "process.stdout.write('100% context left\\n› Ask Codex to do anything\\n');",
    "let input='';let submitted=false;let answered=false;",
    "process.stdin.on('data',data=>{input+=data;if(input.includes('\\u0004'))process.exit(0);",
    "if(!submitted&&input.includes('\\r')){submitted=true;input='';process.stdout.write('FIRST_TURN_SUBMITTED\\n');",
    "setTimeout(()=>{process.stdout.write('Meet GPT-6 Sol\\n› 1. Try new model\\n2. Use existing model\\n');",
    "setTimeout(()=>process.stdout.write(answered?'LATER_MENU_AUTO_ANSWERED\\n':'LATER_MENU_UNANSWERED\\n'),400);},100);}",
    "else if(submitted&&input.includes('\\u001b[B\\r'))answered=true;});",
    'setTimeout(()=>process.exit(0),3500);',
  ].join('');
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', childCode],
    cwd: root,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_PSU_HEADLESS: '1', CODEX_HOME: root,
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20', PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '1' }),
    ownerId,
    io,
    bridgeTty: false,
    onExit: () => {},
  });
  try {
    expect(await waitForOutput(captured, '100% context left')).toBe(true);
    await injectIntoHost(socketPathFor(ownerId), { mode: 'turn', data: 'first turn', ownerId });
    expect(await waitForOutput(captured, 'LATER_MENU_UNANSWERED', 2500), captured()).toBe(true);
    const eventPath = eventLogPathForOwner(ownerId);
    if (existsSync(eventPath)) {
      expect(readFileSync(eventPath, 'utf8')).not.toContain('"kind":"headless-codex-model-choice-kept-existing"');
    }
    // WI-10002543: the successful submit row must carry a non-vacuous
    // attempts count (initial submit + verifier resubmits).
    const deadline = Date.now() + 2_000;
    let delivered: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !delivered) {
      const lines = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n') : [];
      delivered = lines.filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.kind === 'turn-delivered');
      if (!delivered) await sleep(25);
    }
    expect(delivered).toMatchObject({ kind: 'turn-delivered', resubmits: 0, attempts: 1 });
  } finally {
    await injectIntoHost(socketPathFor(ownerId), { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
    await done;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it('records initial submit plus each resubmit as attempts on a verified turn', async () => {
  const ownerId = uniqueOwner('TURN-ATTEMPTS');
  const sock = socketPathFor(ownerId);
  const eventPath = eventLogPathForOwner(ownerId);
  const { captured, io } = fakeIo();
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', [
      "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
      "process.stdout.write('READY\\n');let crs=0;",
      "process.stdin.on('data',data=>{for(const c of data){",
      "if(c==='\\u0004'){process.exit(0);return;}",
      "if(c==='\\r'&&++crs===2){process.stdout.write('SECOND-CR\\n');",
      "setInterval(()=>process.stdout.write('ACTIVE\\n'),10);}}});",
      'setTimeout(()=>process.exit(0),8000);',
    ].join('')],
    cwd: '/tmp',
    env: hermeticEnv({
      PAPERCUSP_SID: ownerId,
      PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '5',
    }),
    ownerId,
    io,
    bridgeTty: false,
    onExit: () => {},
  });
  try {
    expect(await waitForOutput(captured, 'READY', 5000)).toBe(true);
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'needs-retry' })).toBe(true);
    expect(await waitForOutput(captured, 'SECOND-CR', 5000)).toBe(true);
    const deadline = Date.now() + 3000;
    let delivered: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !delivered) {
      const lines = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n') : [];
      delivered = lines.filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.kind === 'turn-delivered');
      if (!delivered) await sleep(25);
    }
    expect(delivered).toMatchObject({ kind: 'turn-delivered' });
    expect(delivered!.resubmits).toBeGreaterThan(0);
    expect(delivered!.attempts).toBe(Number(delivered!.resubmits) + 1);
  } finally {
    await injectIntoHost(sock, { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
    await done;
  }
}, 12_000);

it('quota wall during launch kickoff preserves the host and publishes recovery through discovery', async () => {
  const ownerId = uniqueOwner('QUOTA-STARTUP');
  const sock = socketPathFor(ownerId);
  const { io, captured } = fakeIo();
  let exitCode: number | null = null;
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', [
      "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
      "let walled=false; let recovered=false;",
      "process.stdin.on('data',d=>{",
      "if(d.includes('\\x04')) process.exit(0);",
      "if(d.includes('\\x03')){recovered=true;process.stdout.write('healthy '.repeat(1500)+'CLEARED\\n');return;}",
      "if(d.includes('\\r')){if(recovered)process.stdout.write('RESUMED\\n');",
      "else if(!walled){walled=true;process.stdout.write(\"You've hit your usage limit.\\n\");}",
      "else process.stdout.write('FUTILE-RETRY\\n');}});",
      "process.stdout.write('READY\\n'); setTimeout(()=>process.exit(0),20000);",
    ].join('')],
    cwd: '/tmp',
    env: hermeticEnv({
      PAPERCUSP_SID: ownerId,
      // This case measures quota detection/clearance, not production prompt
      // settling. Keep the real idle/busy gates in the path, but make their
      // test-local budgets deterministic relative to waitForOutput's 3s cap.
      PAPERCUSP_PSU_PTY_IDLE_MS: '20',
      PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30',
      PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '2',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '1',
    }),
    ownerId,
    kickoff: 'trigger-quota',
    io,
    bridgeTty: false,
    onExit: (code: number) => { exitCode = code; },
  });
  try {
    expect(await waitForHost(ownerId)).not.toBeNull();
    expect(await waitForOutput(captured, "You've hit your usage limit", 10000)).toBe(true);
    const eventPath = eventLogPathForOwner(ownerId);
    const deadline = Date.now() + 5000;
    let events = '';
    while (Date.now() < deadline) {
      events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : '';
      if (events.includes('"reason":"quota-blocked"')) break;
      await sleep(25);
    }
    expect(events).toContain('"kind":"submit-verify-unconfirmed"');
    expect(events).toContain('"reason":"quota-blocked"');
    expect(events).not.toContain('"kind":"submit-verify-exhausted"');
    expect(captured()).not.toContain('FUTILE-RETRY');
    expect(exitCode).toBeNull();
    const blocked = findLiveHost(ownerId, PSU_PTY_DIR, ID_OK);
    expect(blocked?.quotaBlocked).toBe(true);
    expect(blocked?.quotaBlockedSinceMs).toBeGreaterThan(0);

    // Recovery output must clear the same discovery record immediately. The
    // subsequent ordinary turn exercises the real reader/socket/host path.
    expect(await injectIntoHost(sock, { mode: 'raw', data: '\x03' })).toBe(true);
    expect(await waitForOutput(captured, 'CLEARED')).toBe(true);
    const recovered = findLiveHost(ownerId, PSU_PTY_DIR, ID_OK);
    expect(recovered?.quotaBlocked).toBe(false);
    expect(recovered?.quotaBlockedSinceMs).toBeNull();
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'resume-work' })).toBe(true);
    expect(await waitForOutput(captured, 'RESUMED')).toBe(true);
  } finally {
    await injectIntoHost(sock, { mode: 'raw', data: '\x04' }).catch(() => false);
    await done;
  }
  expect(exitCode).toBe(0);
  expect(existsSync(sock)).toBe(false);
}, 25000);

it('eligible quota recovery recycles once under the same owner and settles the exact delivery id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psu-quota-recovery-'));
  const codexHome = join(root, 'codex');
  const transcript = join(codexHome, 'sessions', '2026', '09', '07', 'recovered.jsonl');
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  const ownerId = uniqueOwner('QUOTA-RECOVERY');
  const sock = socketPathFor(ownerId);
  const eventPath = eventLogPathForOwner(ownerId);
  const { io, captured } = fakeIo();
  const operationId = String(9_000_000 + Math.floor(performance.now()));
  const marker = '⟦turn-origin:wake-pump nonce:0123456789abcdef⟧';
  const childCode = [
    "const fs=require('node:fs'),path=require('node:path');",
    "const recycled=process.argv[1]==='RECYCLED';",
    "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let b='';",
    "process.stdout.write(recycled?'RECYCLED-READY\\n':'READY\\n');",
    "process.stdin.on('data',d=>{if(d.includes('\\x04'))process.exit(0);b+=d;if(!b.includes('\\r'))return;",
    "const prompt=b;b='';if(!recycled){process.stdout.write(\"You've hit your usage limit.\\n\");return;}",
    "fs.mkdirSync(path.dirname(process.env.TEST_TRANSCRIPT),{recursive:true});",
    "fs.writeFileSync(process.env.TEST_TRANSCRIPT,JSON.stringify({prompt,marker:process.env.TEST_MARKER})+'\\n');",
    "process.stdout.write('RECOVERED-TURN\\n');});",
    'setTimeout(()=>process.exit(0),20000);',
  ].join('');
  let exitCode: number | null = null;
  let recycleMints = 0;
  const done = hostThroughPty({
    command: execPath,
    args: ['-e', childCode, 'ORIGINAL'],
    cwd: '/tmp',
    env: hermeticEnv({
      PAPERCUSP_SID: ownerId,
      PAPERCUSP_AGENT: 'codex',
      PAPERCUSP_LAUNCHED_BY: 'su-integration-leader',
      CODEX_HOME: codexHome,
      TEST_TRANSCRIPT: transcript,
      TEST_MARKER: marker,
      PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30',
      PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '30',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
      PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '10',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '30',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
      PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
    }),
    ownerId,
    io,
    bridgeTty: false,
    nativePersistenceTimeoutMs: 1_000,
    mintRecycleArgs: (a: string[]) => {
      recycleMints += 1;
      return { args: a.slice(0, -1).concat('RECYCLED'), nativeId: null };
    },
    onExit: (code: number) => { exitCode = code; },
  });

  try {
    expect(await waitForOutput(captured, 'READY', 5_000)).toBe(true);
    expect(await injectIntoHost(sock, { mode: 'turn', data: 'trigger-wall', ownerId })).toBe(true);
    expect(await waitForOutput(captured, "You've hit your usage limit", 5_000)).toBe(true);
    const wallDeadline = Date.now() + 3_000;
    while (findLiveHost(ownerId, PSU_PTY_DIR, ID_OK)?.quotaBlocked !== true && Date.now() < wallDeadline) {
      await sleep(20);
    }
    expect(findLiveHost(ownerId, PSU_PTY_DIR, ID_OK)?.quotaBlocked).toBe(true);

    const startedAtMs = Date.now();
    const accepted = await injectIntoHostWithConfirmation(sock, {
      mode: 'recycle',
      data: `${marker}\nresume exact delivery`,
      ownerId,
      deliveryId: operationId,
      quotaRecovery: { operationId, ownerId, startedAtMs },
    });
    expect(accepted).toMatchObject({ ok: true, confirmation: 'acked', reason: 'accepted' });

    const readyDeadline = Date.now() + 8_000;
    let events: Array<Record<string, unknown>> = [];
    while (Date.now() < readyDeadline) {
      events = existsSync(eventPath)
        ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      if (events.some((event) => event.kind === 'quota-recovery-ready')) break;
      await sleep(25);
    }
    expect(captured()).toContain('RECOVERED-TURN');
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'quota-recovery-ready',
      operationId,
      recoveryOwnerId: ownerId,
      startedAtMs,
      reason: 'turn-start-verified',
    }));
    expect(recycleMints).toBe(1);

    const duplicate = await injectIntoHostWithConfirmation(sock, {
      mode: 'turn',
      data: `${marker}\nresume exact delivery`,
      ownerId,
      deliveryId: operationId,
    });
    expect(duplicate).toMatchObject({ ok: true, confirmation: 'acked', reason: 'duplicate-delivery-id' });
    expect(recycleMints).toBe(1);
    expect(findLiveHost(ownerId, PSU_PTY_DIR, ID_OK)?.ownerId).toBe(ownerId);
  } finally {
    if (existsSync(sock)) await injectIntoHost(sock, { mode: 'raw', data: '\x04' }).catch(() => false);
    await done.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
  expect(exitCode).toBe(0);
}, 25000);

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
    // Backend-specific startup readiness (for example Codex's `% context left`
    // marker) must be selected explicitly by a test.  In a fleet session the
    // ambient Codex value would make generic echo-child tests wait for a marker
    // they can never emit, masking the clean-boundary behavior under test.
    PAPERCUSP_AGENT: _agent,
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

/** Child that consumes submitted bytes but never emits output, modeling a
 *  swallowed submit from the host verifier's perspective. */
function silentChildCode(ttlMs: number): string {
  // The child is hosted under a PTY. Put its stdin in raw mode so the PTY's
  // canonical line discipline cannot echo the injected text/CR back through
  // stdout and falsely look like output from a submitted turn.
  return (
    "try{process.stdin.setRawMode&&process.stdin.setRawMode(true);}catch(e){}" +
    `process.stdin.resume();setTimeout(()=>process.exit(0),${ttlMs});`
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

/** A child that models a MID-TURN agent: a worker thread writes a '.' to stdout
 *  every `intervalMs` (a generating TUI repaints constantly) for `busyMs`, then
 *  goes QUIET (back at its prompt). Keeping the emitter off the agent's main
 *  event loop prevents a delayed timer from creating a false output-quiet window
 *  while the fixture is meant to stay busy. It also echoes 'ECHO:<line>' per
 *  newline-terminated stdin line, so a CR-submitted wake turn is observable.
 *  Self-exits after ttlMs. The output stream is what the host's mid-turn gate watches. */
function busyThenIdleChildCode(busyMs: number, intervalMs: number, ttlMs: number): string {
  return (
    "const {Worker}=require('node:worker_threads');" +
    `const emitter=new Worker(${JSON.stringify(`setInterval(()=>process.stdout.write('.'),${intervalMs})`)},{eval:true});` +
    `setTimeout(()=>{void emitter.terminate();},${busyMs});` +
    "process.on('exit',()=>{void emitter.terminate();});" +
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
    `setTimeout(()=>process.exit(0),${ttlMs});`
  );
}

/** A RAW-mode child that announces 'READY', then emits 'SUBMIT:<buffer>' on each
 *  CR. Raw mode is the load-bearing part for a keystroke test: the pty's
 *  canonical line discipline would otherwise ECHO every typed byte back onto
 *  stdout, which reads as agent output and makes the host's busy gate defer the
 *  inject forever (observed as `busy-gate-expired`) — so the submit-verify
 *  window under test is never even reached. Self-exits after ttlMs; '\x04' quits. */
function rawSubmitChildCode(ttlMs: number): string {
  return (
    "try{process.stdin.setRawMode&&process.stdin.setRawMode(true);}catch(e){}" +
    "process.stdin.setEncoding('utf8');process.stdin.resume();let b='';" +
    "process.stdout.write('READY\\n');" +
    "process.stdin.on('data',s=>{for(const c of s){" +
    "if(c==='\\u0004'){process.exit(0);}" +
    "else if(c==='\\r'||c==='\\n'){if(b){process.stdout.write('SUBMIT:'+b+'\\n');b='';}}" +
    "else b+=c;}});" +
    `setTimeout(()=>process.exit(0),${ttlMs});`
  );
}

describe('psu-pty-host mode:turn CR-submit via the real discovery handshake (C2)', () => {
  it.each(['settled', 'active'] as const)(
    'Codex idle repaint with a %s native turn uses only a verified completion boundary',
    async (state) => {
      const root = mkdtempSync(join(tmpdir(), 'codex-warm-turn-boundary-'));
      const ownerId = uniqueOwner(`CODEX-WARM-${state}`);
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const transcript = join(root, 'sessions', '2026', '09', '12', 'rollout-current.jsonl');
      mkdirSync(join(root, 'sessions', '2026', '09', '12'), { recursive: true });
      writeFileSync(transcript, JSON.stringify({
        type: 'event_msg', timestamp: new Date().toISOString(),
        payload: { type: state === 'settled' ? 'task_complete' : 'task_started', turn_id: 'turn-current' },
      }) + '\n');
      const { captured, io } = fakeIo();
      const childCode = [
        "process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');",
        "process.stdout.write('READY\\n');setInterval(()=>process.stdout.write('IDLE-REPAINT\\n'),15);",
        "let line='';process.stdin.on('data',d=>{for(const c of d){",
        "if(c==='\\u0004')process.exit(0);",
        "else if(c==='\\r'){if(line){process.stdout.write('SUBMITTED:'+line+'\\n');line='';}}else line+=c;}});",
        'setTimeout(()=>process.exit(0),4000);',
      ].join('');
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: root,
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'codex',
          CODEX_HOME: root,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: () => {},
      });
      try {
        // EI-23245736218610710: this full-file suite can run beside other PTY
        // integrations. Discovery is not child readiness (EI-7662 above), so use
        // the same bounded READY-marker budget as the other loaded-host cases in
        // this file instead of turning a scheduler pause into a lifecycle red.
        expect(await waitForOutput(captured, 'READY', 10_000)).toBe(true);
        expect(await injectIntoHost(sock, { mode: 'turn', data: `warm-${state}`, ownerId })).toBe(true);
        if (state === 'settled') {
          // injectIntoHost acknowledges admission before the detached gate/write
          // pipeline settles. Poll its observable submit marker with the file's
          // established bounded shared-host budget; never replace this with a
          // flat sleep or treat the admission ACK as delivery proof.
          expect(await waitForOutput(captured, 'SUBMITTED:warm-settled', 5_000)).toBe(true);
          const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          expect(events).not.toContain('"kind":"busy-gate-expired"');
        } else {
          await sleep(700);
          expect(captured()).not.toContain('SUBMITTED:warm-active');
          const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          expect(events).toContain('"kind":"busy-gate-expired"');
          expect(events).toContain('"mode":"turn"');
        }
      } finally {
        await injectIntoHost(sock, { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

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

      // WI-785151: poll for the echo instead of asserting once after a fixed
      // sleep. Same reason the header gives for waitForHost — these tests run
      // back-to-back sharing the box's CPU/IO with other agents' suites, so a
      // flat sleep that is generous in isolation is a coin flip under load.
      expect(await waitForOutput(captured, 'ECHO:wake-turn-A', 5000)).toBe(true);

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

  // WI-1378748 (supersedes the WI-41044 shape of this case). This case used to
  // assert that an unconfirmed `mode:turn` submit SIGTERMs the host. That is
  // exactly the outage: the child below is SILENT BUT ALIVE, which is precisely
  // what a rate-limited agent looks like from the pty (a Claude Code sitting on
  // a weekly-quota wall repaints nothing), and the host answered by killing it
  // mid-work. Measured 2026-08-30: 160 hosts killed, 102 on a `turn inject`,
  // in mass clusters because one coord broadcast wakes every session at once.
  //
  // A wake inject is a NOTIFICATION; failing to deliver it may cost the wake and
  // nothing more. So the bounded-CR half of the original assertion is KEPT (no
  // endless retries — still capped at maxResubmits, still recorded), while the
  // teardown half is INVERTED: the session must survive and exit on its OWN
  // terms. The host-fatal path still exists for STARTUP submits and is covered
  // by psu-pty-host.integration.test.ts / the carry-delivery guard; the control
  // socket cannot reach it, since it only ever emits turn/reset injects.
  it(
    'WI-1378748: an unconfirmed wake submit is bounded and recorded, but never kills the live session',
    async () => {
      const ownerId = uniqueOwner('SUBMIT-UNCONFIRMED');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      const done = hostThroughPty({
        command: execPath,
        // WI-785151: the child's self-exit TTL must NOT be able to win a race
        // against this test's own setup. It used to be 8000ms, which is a wall
        // clock competing with a load-sensitive prologue (spawn + waitForHost +
        // inject) — and this file's header already documents that waitForHost
        // alone can take seconds once several real node-pty children share the
        // box.
        //
        // WI-1378748: the TTL is now also the test's TEARDOWN, because nothing
        // else ends this child any more — surviving the exhaustion IS the
        // assertion. It must therefore comfortably outlast that load-sensitive
        // prologue (so exhaustion is always declared first, on a child that is
        // still alive to be spared) while still landing inside the case's own
        // raised timeout. If the prologue ever did outrun it, the event-log
        // assertion below goes RED rather than passing vacuously.
        args: ['-e', silentChildCode(15_000)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // Keep the recurrence test fast while preserving a second quiet poll
          // after the final CR, which is when exhaustion is declared.
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '1',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number, signal: string | null) => {
          exitCode = c;
          exitSignal = signal;
        },
      });

      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();
      expect(await injectIntoHost(host!.sock, { mode: 'turn', data: 'never-confirmed' })).toBe(true);

      // Wait for the verifier to spend its whole CR budget and give up. Polling
      // the event log (rather than sleeping a fixed span) keeps this robust on a
      // loaded box, where the verify window drifts.
      const eventLog = eventLogPathForOwner(ownerId);
      const deadline = Date.now() + 10_000;
      let events = '';
      while (Date.now() < deadline) {
        events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
        if (events.includes('"kind":"submit-verify-unconfirmed"')) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // Recorded, and still BOUNDED — the CR cap is the half of WI-41044 that
      // was always right: an undeliverable wake must not retry forever.
      expect(events).toContain('"kind":"submit-verify-unconfirmed"');
      expect(events).toContain('"resubmits":2');
      expect(events).toContain('"terminated":false');
      // The kill is gone. If this string ever comes back on a wake inject, the
      // mass-kill outage is back with it.
      expect(events).not.toContain('"kind":"submit-verify-exhausted"');

      // THE POINT: the session is still alive and still serving. A dead host
      // unlinks both of these on the way out, so their presence after the
      // verifier gave up is the survival proof.
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);
      expect(exitCode).toBeNull();
      expect(exitSignal).toBeNull();

      // And it ends on its OWN terms (the child's TTL), never by SIGTERM.
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(exitSignal).toBeNull();
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    30_000,
  );
});

// EI-19311270129974785: "a single wake delivery is re-attempted 4x and injects 3
// duplicate agent turns". Root cause: the client's ack-wait can time out (or the
// host's ack write-back can fail) even though the host is ALREADY unstoppably
// committed to delivering — so a client retry with the SAME delivery id, arriving
// AFTER the ORIGINAL attempt already completed (the turnCoalescer's fold-while-
// pending mechanism does not help here — its waiter slot was already claimed and
// cleared by the first delivery, so a later retry reads as a brand-new, unrelated
// request), must be recognized and short-circuited by the host — never re-injected
// as a second real duplicate turn.
describe('psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785)', () => {
  it(
    'the SAME deliveryId injected twice (second arriving after the first already landed) produces exactly ONE echoed turn',
    async () => {
      const ownerId = uniqueOwner('DEDUP-SEQ');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(3500)],
        cwd: '/tmp',
        env: { ...hermeticEnv(), PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      await waitForHost(ownerId);

      // Original attempt: delivered and echoed — this is the wake the client's OWN
      // ack-wait then (in the real bug) times out on, or whose ack write-back fails,
      // despite it having already landed.
      const ok1 = await injectIntoHost(sock, { mode: 'turn', data: 'dup-wake', deliveryId: 'dedup-seq-1' });
      expect(ok1).toBe(true);
      expect(await waitForOutput(captured, 'ECHO:dup-wake')).toBe(true);

      // The client's retry: SAME deliveryId, arriving well after the original's
      // coalescer waiter slot was already claimed+cleared (so, pre-fix, this reads
      // as an unrelated fresh request and injects a second real turn).
      const ok2 = await injectIntoHost(sock, { mode: 'turn', data: 'dup-wake', deliveryId: 'dedup-seq-1' });
      expect(ok2).toBe(true); // the client still sees success — just deduped, not re-run

      await sleep(500);
      const echoCount = (captured().match(/ECHO:dup-wake/g) ?? []).length;
      expect(echoCount).toBe(1); // NOT 2 — the retry never reached the pty a second time

      await injectIntoHost(sock, { mode: 'raw', data: 'QUIT\n' });
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'a SAME deliveryId retry refreshes the pending loop text before the busy gate opens, then still injects exactly once (EI-21428742689578243)',
    async () => {
      const idleMs = 250;
      const ownerId = uniqueOwner('DEDUP-PENDING-REFRESH');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, type, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', echoChildCode(6500)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: String(idleMs),
          PAPERCUSP_PSU_PTY_IDLE_CAP_MS: '8000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '120',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        advSessionId: 35_092,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      let typing = true;
      const typingTask = (async () => {
        while (typing) {
          type('x');
          await sleep(60);
        }
      })();

      const envelope = {
        mode: 'turn' as const,
        deliveryId: 'pending-refresh-1',
        routineId: 'rt-pending-refresh',
        fireNumber: 4,
      };
      expect(await injectIntoHost(sock, { ...envelope, data: 'STALE checkpoint hash; age=900s' })).toBe(true);
      await sleep(150);
      expect(captured()).not.toContain('ECHO:STALE');

      // The durable pump retries the SAME delivery after executeWake has rebuilt
      // its LIVE RE-CHECK block. The host must replace the queued bytes rather than
      // treating its first accepted snapshot as immutable.
      expect(await injectIntoHost(sock, { ...envelope, data: 'FRESH checkpoint hash; age=2s' })).toBe(true);

      typing = false;
      await typingTask;
      await sleep(idleMs + 100);
      type('\r');
      expect(await waitForOutput(captured, 'ECHO:x', 3000)).toBe(true);
      expect(await waitForOutput(captured, 'ECHO:FRESH checkpoint hash; age=2s', 3000)).toBe(true);
      expect(captured()).not.toContain('ECHO:STALE checkpoint hash; age=900s');
      expect((captured().match(/ECHO:FRESH checkpoint hash; age=2s/g) ?? []).length).toBe(1);

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'keeps a folded delivery ID retryable when its parent waiter defers at the busy cap (F03)',
    async () => {
      const busyMs = 1_500;
      const ownerId = uniqueOwner('DEDUP-FOLDED-DEFER');
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        // Keep the parent waiter busy past its short cap, then leave the child
        // quiet long enough for a retry to exercise a fresh delivery cycle.
        args: ['-e', busyThenIdleChildCode(busyMs, 50, 5_000)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: '60',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '120',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '1',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        advSessionId: 35_093,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      try {
        const host = await waitForHost(ownerId);
        expect(host).not.toBeNull();
        // Do not race child startup: the busy gate must observe genuine output.
        expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);

        const envelope = {
          mode: 'turn' as const,
          ownerId,
          routineId: 'f03-folded-routine',
        };
        const parent = await injectIntoHostWithConfirmation(sock, {
          ...envelope,
          data: 'F03_DIAG parent-A',
          deliveryId: 'f03-parent-a',
          fireNumber: 1,
        });
        expect(parent).toMatchObject({ ok: true, confirmation: 'acked', reason: 'accepted' });

        // B has a DISTINCT durable delivery ID but the SAME routine source, so
        // it folds into A's gate waiter. Its ID must remain retryable if A is
        // later dropped by the busy cap.
        const folded = await injectIntoHostWithConfirmation(sock, {
          ...envelope,
          data: 'F03_DIAG folded-B',
          deliveryId: 'f03-folded-b',
          fireNumber: 2,
        });
        expect(folded).toMatchObject({
          ok: true,
          confirmation: 'acked',
          reason: 'coalesced-into-pending-turn',
        });

        // Anchor on the parent's actual cap expiry, then wait past the original
        // busy window + quiet gate before retrying B.
        const capDeadline = Date.now() + 3_000;
        let events = '';
        while (Date.now() < capDeadline) {
          events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          if (events.includes('"kind":"busy-gate-expired"')) break;
          await sleep(20);
        }
        expect(events).toContain('"kind":"busy-gate-expired"');
        await sleep(busyMs + 300);
        // P-005 / D-007: the PARENT is no longer abandoned when the busy cap expires — it
        // is re-armed and delivered at the next clean boundary, so its own echo
        // legitimately appears in this window. What THIS case guards is narrower and
        // unchanged: the FOLDED delivery ID must not be burned by that settlement. So
        // assert on the folded payload specifically. The original bare
        // `not.toContain('ECHO:F03_DIAG')` matched either payload, which after P-005 is
        // an assertion that the wake was ABANDONED — precisely the behavior the item
        // exists to remove — so leaving it would have pinned the old defect in place.
        expect(captured()).not.toContain('ECHO:F03_DIAG folded-B');
        // Prove the re-arm actually ran, rather than inferring it from the absence of the
        // folded echo: if the re-arm silently stopped firing, every assertion below would
        // still pass while the wake-loss this plan fixes had quietly returned.
        const afterCap = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
        expect(afterCap).toContain('"kind":"wake-rearm-queued"');

        const retry = await injectIntoHostWithConfirmation(sock, {
          ...envelope,
          data: 'F03_DIAG folded-B',
          deliveryId: 'f03-folded-b',
          fireNumber: 2,
        });
        expect(retry).toMatchObject({ ok: true, confirmation: 'acked', reason: 'accepted' });
        expect(await waitForOutput(captured, 'ECHO:F03_DIAG folded-B', 6_000)).toBe(true);
        await sleep(300);

        const output = captured();
        expect((output.match(/ECHO:F03_DIAG folded-B/g) ?? []).length).toBe(1);
        // P-005 / D-007: the parent is DELIVERED now — re-armed at the next clean boundary
        // instead of abandoned at the busy cap — so assert it arrived EXACTLY ONCE. That is
        // strictly stronger than the original `not.toContain(...)`: it proves the re-arm ran
        // AND that it did not double-inject alongside the folded retry, where the old form
        // could only ever prove the wake had been lost.
        expect((output.match(/ECHO:F03_DIAG parent-A/g) ?? []).length).toBe(1);
      } finally {
        await injectIntoHost(sock, { mode: 'raw', data: '\x04', ownerId }).catch(() => false);
        await done;
        rmSync(meta, { force: true });
      }
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
    },
    20_000,
  );

  it(
    'a DIFFERENT deliveryId with the SAME text is a genuinely new delivery — not deduped',
    async () => {
      // Guards against an over-broad fix: dedup must key off the delivery ID, never
      // the text, or a loop legitimately firing the same reminder twice would be
      // wrongly suppressed on its second, genuinely distinct delivery.
      const ownerId = uniqueOwner('DEDUP-DISTINCT');
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
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // This generic echo child never produces whatever confirmation pattern
          // submitVerify actually looks for, so it retries the CR (default quiet
          // threshold 6000ms) — which holds the inject mutex the SECOND injection
          // below needs. Shrink both so the first delivery's pipeline (mutex +
          // submit-verify) fully settles well within this test's budget.
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '80',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '150',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      await waitForHost(ownerId);

      const ok1 = await injectIntoHost(sock, { mode: 'turn', data: 'same-text', deliveryId: 'distinct-1' });
      expect(ok1).toBe(true);
      expect(await waitForOutput(captured, 'ECHO:same-text')).toBe(true);
      // Let the first delivery's OWN pipeline fully settle (submit-verify, mutex
      // release, turnCoalescer.claim()) before firing the second — otherwise the
      // pre-existing P-001a same-TEXT coalescer (an earlier, unrelated mechanism —
      // see makeTurnCoalescer) can fold the second write into the first's still-
      // open waiter slot purely because the text matches, which is not what this
      // test is isolating (it wants to prove the ID-based dedup does NOT suppress
      // a genuinely distinct delivery id, not exercise the text coalescer).
      await sleep(300);

      const ok2 = await injectIntoHost(sock, { mode: 'turn', data: 'same-text', deliveryId: 'distinct-2' });
      expect(ok2).toBe(true);

      // Poll (not a flat sleep) for the SECOND echo — injection 2 may itself queue
      // behind injection 1's OWN submit-verify resubmit cycle on the injectMutex
      // (this generic echo child never produces whatever confirmation submitVerify
      // is looking for, so BOTH deliveries retry the CR up to SUBMIT_VERIFY_MAX_RESUBMITS
      // times before the mutex frees), so a short fixed sleep undercounts.
      const sawTwo = await waitForOutput(() => String((captured().match(/ECHO:same-text/g) ?? []).length), '2', 4000);
      expect(sawTwo).toBe(true);
      const echoCount = (captured().match(/ECHO:same-text/g) ?? []).length;
      expect(echoCount).toBe(2); // a genuinely distinct delivery id is NOT deduped

      await injectIntoHost(sock, { mode: 'raw', data: 'QUIT\n' });
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
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

      // Stop typing, then explicitly submit the owner line. Idle is not enough:
      // the composer gate must wait for this CR instead of appending the wake to
      // the quiet-but-unsubmitted x* line.
      typing = false;
      await sleep(idleMs + 100);
      type('\r');
      expect(await waitForOutput(captured, 'ECHO:x', 3000)).toBe(true);
      expect(await waitForOutput(captured, 'ECHO:gated-wake', 3000)).toBe(true);

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('psu-pty-host owner composer gate (EI-20199370837439455)', () => {
  it(
    'never appends a loop-fire envelope to a quiet, unsubmitted owner line',
    async () => {
      const ownerId = uniqueOwner('COMPOSER');
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
          PAPERCUSP_PSU_PTY_IDLE_MS: '120',
          PAPERCUSP_PSU_PTY_IDLE_CAP_MS: '350',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '80',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '1',
        },
        ownerId,
        advSessionId: 9998,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();

      // This is the production failure shape: the owner has stopped typing, but
      // has not pressed Enter, when the machine wake reaches the PTY.
      type('owner goal');
      await sleep(200);
      const first = await injectIntoHost(host!.sock, {
        mode: 'turn',
        data: '⟦turn-origin:loop-fire nonce:first⟧\n[await-event] loop wake',
      });
      expect(first).toBe(true);
      await sleep(900);
      expect(captured()).not.toContain('ECHO:⟦turn-origin:loop-fire');
      expect(captured()).not.toContain('ECHO:owner goal⟦turn-origin:loop-fire');

      // Submitting the owner line is safe; the deferred wake was deliberately
      // left for the next natural turn rather than appended to it.
      type('\r');
      // WI-785151: poll rather than assert once after a fixed sleep.
      expect(await waitForOutput(captured, 'ECHO:owner goal', 5000)).toBe(true);

      const second = await injectIntoHost(host!.sock, {
        mode: 'turn',
        data: '⟦turn-origin:loop-fire nonce:second⟧\n[await-event] loop wake',
      });
      expect(second).toBe(true);
      // Wait for the child acknowledgement, not the bare nonce: terminal echo
      // can expose the injected input before the child has processed it.
      const secondAcknowledgement = 'ECHO:⟦turn-origin:loop-fire nonce:second⟧';
      expect(await waitForOutput(captured, secondAcknowledgement, 5000)).toBe(true);
      const output = captured();
      expect(output).toContain(secondAcknowledgement);
      expect(output).not.toContain('ECHO:owner goal⟦turn-origin:loop-fire');

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
      expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);

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
      // WI-785151: this was `await sleep(900); expect(captured()).toContain(...)`,
      // and it is the assertion that actually flaked (measured 2 failures in 5
      // runs at ONE sha, "expected false to be true"). The budget was ~150ms:
      // the child emits until ~900ms, then OUTPUT_QUIET_MS=200 must elapse, then
      // the gate writes and the echo round-trips — against a 350+900ms wall
      // clock. Under fleet load that margin is gone. Polling asserts the SAME
      // thing (the turn DOES land once the agent is quiet) without pinning WHEN.
      // The negative check above stays a fixed sleep on purpose: it proves the
      // turn is HELD during the busy window, and a slow box only makes that
      // direction more likely to hold, never less.
      expect(await waitForOutput(captured, 'ECHO:midturn-wake', 6000)).toBe(true);

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'same-source turns stacked while the agent is busy COALESCE into ONE annotated delivery (compaction-continuity P-001a)',
    async () => {
      // The measured 9× duplication: N same-loop wakes arrive while the agent is
      // mid-turn; each connection handler waits at the gates and pre-fix ALL N
      // injected back-to-back the moment the prompt returned. Post-fix the first
      // becomes the waiter, later same-key arrivals FOLD into it (newest text
      // wins), and exactly ONE annotated turn lands.
      const ownerId = uniqueOwner('COALESCE');
      const { captured, io } = bridgedIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        // Busy (emitting '.') for 900ms, then quiet; self-exits at 5000ms.
        args: ['-e', busyThenIdleChildCode(900, 50, 5000)],
        cwd: '/tmp',
        env: {
          ...hermeticEnv(),
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: '60',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000',
        },
        ownerId,
        advSessionId: 8883,
        io,
        bridgeTty: true,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      const host = await waitForHost(ownerId);
      expect(host).not.toBeNull();
      // EI-7662: only inject once the child has GENUINELY started emitting.
      expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);

      // Three same-source wakes while mid-turn: identical first line (the coalesce
      // key — a loop's wake texts share it), differing detail (the checkpoint splice).
      for (let n = 1; n <= 3; n++) {
        const ok = await injectIntoHost(host!.sock, {
          mode: 'turn',
          data: `LOOPWAKE goal G\ndetail-${n}`,
        });
        expect(ok).toBe(true);
      }

      // After the busy window (~900ms) + quiet gate (200ms), ONE delivery lands.
      // WI-785151: anchor on the delivery being OBSERVED rather than on a flat
      // 1600ms. The settle AFTER the anchor is what gives a (wrongly) duplicated
      // delivery time to show up, so the "exactly one" assertion below keeps its
      // falsifying power — the old flat sleep had no observation anchor at all,
      // so under load it could sample before even the FIRST delivery landed and
      // read a race as a clean pass.
      expect(await waitForOutput(captured, 'ECHO:detail-3', 6000)).toBe(true);
      await sleep(500);
      const out = captured();
      // Exactly one turn delivered — not three.
      expect(out.split('ECHO:LOOPWAKE goal G').length - 1).toBe(1);
      // Newest text won; the folded earlier texts were never written at all.
      expect(out).toContain('ECHO:detail-3');
      expect(out).not.toContain('detail-1');
      expect(out).not.toContain('detail-2');
      // The delivery is annotated so the agent treats it as ONE wake.
      expect(out).toContain('2 duplicate queued wakes were coalesced');

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
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
      expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true);

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

describe(
  'psu-pty-host clean-boundary-only kill (WI-1818, D-006): reset/recycle refuse mid-turn',
  () => {
    it(
      'a RECYCLE injected while the agent is MID-TURN does NOT kill the child until it settles — no boot++ while busy',
      async () => {
        // The data-loss guard this WI adds: previously the mid-turn busy-gate only
        // ran `if (bridgeTty && msg.gated)`, so a host with no bridged terminal
        // (bridgeTty:false — exactly this test's io, and every existing recycle
        // integration test) let a `recycle` kill the CURRENT child unconditionally,
        // even mid-turn, losing whatever in-flight work that turn held. The fix
        // makes the agent-busy check unconditional for every gated verb. Prove it
        // here: inject `recycle` WHILE the pre-recycle child is still emitting
        // (mid-turn) — the process must NOT be replaced until output goes quiet.
        const ownerId = uniqueOwner('RECYCLE-MIDTURN');
        const sock = socketPathFor(ownerId);
        const meta = metaPathFor(ownerId);
        const { captured, io } = fakeIo(); // bridgeTty:false — the exact gap closed

        const childCode =
          "process.stdout.write('BOOT:'+process.pid+'\\n');" +
          "process.stdin.setEncoding('utf8');let b='';" +
          "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
          "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
          "const iv=setInterval(()=>process.stdout.write('.'),50);" +
          'setTimeout(()=>clearInterval(iv),900);' + // "mid-turn" (busy) for ~900ms
          'setTimeout(()=>process.exit(0),8000);';

        let exitCode: number | null = null;
        const done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: '/tmp',
          env: {
            ...hermeticEnv(),
            PAPERCUSP_SID: ownerId,
            TERM: 'xterm-256color',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
            PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000', // generous — the child DOES go quiet
            // This fake child emits BOOT but no backend-specific composer marker.
            // Exercise the established bounded fallback rather than waiting the
            // production 15s marker window (the sibling recycle tests do the same).
            PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          },
          ownerId,
          io,
          bridgeTty: false,
          onExit: (c: number) => {
            exitCode = c;
          },
        });

        await waitForHost(ownerId);
        expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true); // genuinely busy now

        const bootsAtInject = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        expect(bootsAtInject).toHaveLength(1);

        // Fire the recycle WHILE mid-turn (still emitting '.').
        const ok = await injectIntoHost(sock, { mode: 'recycle', data: 'CARRIED' });
        expect(ok).toBe(true);

        // Still within the busy window: the kill must be HELD — no second BOOT yet.
        await sleep(400);
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);

        // After the ORIGINAL child goes quiet (≥900ms) + the output-quiet window, the
        // gate releases and the (now-settled) recycle proceeds: kill + respawn. The
        // FRESH child runs the SAME script, so it busy-emits '.' for another ~900ms
        // before the carry-inject retry loop's own waitAtPrompt lets the carry land —
        // Wait on the outcome rather than a fixed wall-clock guess: under a
        // loaded full gate the same two busy windows can exceed 3.2s even
        // though the bounded carry retry is still progressing normally.
        expect(await waitForOutput(captured, 'ECHO:CARRIED', 6000)).toBe(true);
        const bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        expect(bootsAfter).toHaveLength(2); // the recycle DID eventually fire, once settled
        expect(bootsAfter[1]).not.toBe(bootsAfter[0]);
        expect(captured()).toContain('ECHO:CARRIED'); // carry landed on the fresh context

        await injectIntoHost(sock, { mode: 'raw', data: 'QUIT\n' });
        const code = await done;
        expect(code).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      },
      25_000,
    );

    it(
      'a RESET injected while the agent is MID-TURN does NOT clear the context until it settles',
      async () => {
        // Same guard, the `reset` (RESET-CONTEXT) verb: the write plan (/clear +
        // carry) must not land into a still-generating TUI — it would corrupt the
        // busy turn AND drop whatever that turn hadn't yet committed.
        const ownerId = uniqueOwner('RESET-MIDTURN');
        const sock = socketPathFor(ownerId);
        const meta = metaPathFor(ownerId);
        const { captured, io } = fakeIo(); // bridgeTty:false — the exact gap closed

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
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
            PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000', // generous — the agent DOES go quiet
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
            PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '200',
          },
          ownerId,
          io,
          bridgeTty: false,
          onExit: (c: number) => {
            exitCode = c;
          },
        });

        await waitForHost(ownerId);
        expect(await waitForOutput(captured, '.', CHILD_START_OUTPUT_TIMEOUT_MS)).toBe(true); // genuinely busy now

        const ok = await injectIntoHost(sock, { mode: 'reset', data: 'midturn-reset-carry' });
        expect(ok).toBe(true);

        // Still within the busy window: the /clear + carry must be HELD — nothing
        // written into the busy child yet.
        await sleep(400);
        expect(captured()).not.toContain('ECHO:midturn-reset-carry');
        expect(captured()).not.toContain('midturn-reset-carry');

        // After the agent goes quiet (≥900ms) + the output-quiet window, the gate
        // releases: /clear submits, settles, then the carry lands.
        // WI-785151: poll for the carry instead of asserting once after a flat
        // 1400ms. This is the SAME shape as the mid-turn wake assertion that
        // measurably flaked — a positive assertion whose budget is the slack
        // left over after two load-sensitive windows (busy ≥900ms + the 200ms
        // output-quiet gate) — so it is the same bug whether or not it has been
        // observed failing yet. The negative check above stays a fixed sleep on
        // purpose: it proves the carry is HELD while the child is busy, and a
        // slow box only makes that direction more likely to hold.
        expect(await waitForOutput(captured, 'ECHO:midturn-reset-carry', 6000)).toBe(true);

        await injectIntoHost(sock, { mode: 'raw', data: 'QUIT\n' });
        const code = await done;
        expect(code).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      },
      20_000,
    );
  },
);

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

      // WI-785151: anchor on A's delivery being OBSERVED rather than on a flat
      // 700ms. Note this also STRENGTHENS the cross-talk assertion below: B is
      // now given at least as long as A actually needed (rather than a fixed
      // window that might expire before either child had a chance to echo), so
      // "B never saw it" is checked at a point where a leak would have had time
      // to appear. Under load the old flat sleep could sample before A itself
      // had echoed, reading "neither child has output yet" as a clean pass.
      expect(await waitForOutput(() => a.captured(), 'ECHO:only-for-A', 5000)).toBe(true);

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
          // EI-8188: the agent-busy mid-turn gate (coord-wake-mid-turn-2026-06-30)
          // defers every gated `turn` inject until the pty's OUTPUT has been quiet
          // for OUTPUT_QUIET_MS (prod default 1500ms) — and the child's own READY
          // marker below (EI-7662) counts as output, so `lastOutputAt` is reset to
          // "just now" the instant we're allowed to inject. Every OTHER test in this
          // file that can hit this gate already pins OUTPUT_QUIET_MS to a small
          // deterministic value (see the C2 describe block above); this test never
          // did, so it silently inherited the full 1500ms production wait — pushing
          // the real submit past this test's fixed 700ms post-inject sleep and
          // failing with only the pre-submit 'READY' marker captured. Pin it fast
          // here too so the CR-delay behavior under test isn't entangled with an
          // unrelated gate's wall-clock default.
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
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
      // EI-21432828786219414: this full-file integration case can share the
      // machine with several PTY children. The marker is still the authoritative
      // readiness signal; give the child enough startup budget under that load
      // instead of turning a slow spawn into a false paste-detector failure.
      expect(await waitForOutput(captured, 'READY', 10_000)).toBe(true);

      const ok = await injectIntoHost(host!.sock, { mode: 'turn', data: 'paste-then-enter' });
      expect(ok).toBe(true);

      // Wait past the 120ms CR delay for the separate Enter to land + submit.
      // WI-785151: poll rather than assert once after a flat 700ms. This case
      // already carries an EI-21432828786219414 note above about sharing the
      // machine with several PTY children and having widened the READY wait to
      // 10s for exactly that reason — the submit assertion right after it was
      // left on a fixed sleep, which is the same load-sensitivity one line down.
      expect(await waitForOutput(captured, 'SUBMIT:paste-then-enter', 5000)).toBe(true);

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
    },
    20_000,
  );
});

/**
 * WI-10001508 — owner keystrokes during submit verification must DEFER the
 * carry, never destroy it.
 *
 * The submit verifier aborts with `human-input` when `lastInputAt` advances
 * mid-verify (psu-pty-host.mjs, makeSubmitVerifier). That abort used to become
 * a terminal `respawn-carry-dropped {reason:'submit-verification-aborted-
 * human-input'}`: the successor booted with its carry document but never
 * received the turn telling it to act, so it sat at an idle prompt until a
 * human resumed it by hand.
 *
 * Measured 2026-09-15 across all 14,586 per-owner ledgers: that reason is only
 * 0.6% of fleet-wide carry drops but was 100% of the drops on the session the
 * OWNER was typing into — the interactive case, where the owner's own keystroke
 * is what destroyed the delivery. Asserted as the observable contract (retry
 * recorded + the prompt still submitted), not as the shape of the loop.
 *
 * Exercised through the LAUNCH KICKOFF seam rather than carry-respawn ON
 * PURPOSE. Both call the same `injectTurnAtPrompt` — the function this fix
 * lives in — but a production carry-respawn additionally demands a native
 * transcript proof afterwards (`verifyNativeTurnStartWithRetry` needs a leading
 * turn-origin marker AND, for claude, a nativeId per
 * `carryTurnProofRequiresNativeId`). A hermetic fixture cannot satisfy that
 * against the real homedir, so it drops with `turn-start-unverified` BEFORE
 * this path's contract is observable — measured here, not assumed. The drill
 * seam skips that proof, but mirrors every row into the BOX-WIDE
 * ~/.papercusp/psu-pty/carry-drills.events.jsonl (PSU_PTY_DIR is a module
 * constant, not env-overridable), which a test must never write into.
 *
 * Claude-path ON PURPOSE: under `PAPERCUSP_AGENT=codex` the earlier
 * `freshChildWasInterrupted()` guard drops with `fresh-child-owner-input`
 * BEFORE verification is ever reached, so a codex fixture would pass while
 * proving nothing about this path.
 */
describe('owner keystrokes during submit verification (WI-10001508)', () => {
  it(
    'retries the prompt once the keyboard settles instead of dropping it',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-human-input-retry-'));
      const ownerId = uniqueOwner('HUMAN-INPUT-RETRY');
      const { captured, io, type } = bridgedIo();
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', rawSubmitChildCode(12_000)],
        kickoff: 'KICKOFF-CARRY',
        cwd: root,
        env: hermeticEnv({
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_IDLE_MS: '20',
          PAPERCUSP_PSU_PTY_IDLE_CAP_MS: '200',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '60',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '250',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '150',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '30',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '150',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
        }),
        ownerId,
        io,
        bridgeTty: true,
        onExit: () => {},
      });
      // The verify window is bounded (POLL_MS x POLLS), so a single keystroke
      // would race it and fail in the direction that LOOKS like a pass. Type
      // CONTINUOUSLY across the whole window so the overlap is guaranteed, then
      // stop — the retry can only land once the keyboard is quiet again.
      let typing: ReturnType<typeof setInterval> | undefined;
      try {
        const booted = await waitForOutput(captured, 'READY', 6000);
        expect(booted, `captured=${JSON.stringify(captured().slice(0, 600))}`).toBe(true);
        typing = setInterval(() => type('x'), 10);
        await sleep(900);
        clearInterval(typing);
        typing = undefined;

        let rows: Record<string, unknown>[] = [];
        let retried = false;
        const deadline = Date.now() + 9000;
        while (!retried && Date.now() < deadline) {
          if (existsSync(eventLogPathForOwner(ownerId))) {
            rows = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            retried = rows.some((row) => row.kind === 'submit-verify-human-input-retry');
          }
          if (!retried) await sleep(25);
        }
        // The fix's own observable: the abort was treated as TRANSIENT.
        expect(retried, `kinds=${JSON.stringify(rows.map((row) => row.kind))}`).toBe(true);
        // ...and the prompt still landed — a retry that never delivers is the
        // same strand wearing a different reason.
        const submitted = await waitForOutput(captured, 'SUBMIT:', 6000);
        expect(submitted, `captured=${JSON.stringify(captured().slice(-600))}`).toBe(true);
        expect(captured()).toContain('KICKOFF-CARRY');
      } finally {
        if (typing) clearInterval(typing);
        await injectIntoHost(socketPathFor(ownerId), {
          mode: 'raw',
          data: '\x04',
          ownerId,
        }).catch(() => false);
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
