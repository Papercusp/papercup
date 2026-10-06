// @vitest-environment node
/**
 * psu-park.integration.test.ts — psu process-free parking end to end
 * (psu-process-free-parking-2026-10-06 P-017, decisions D-002/D-003).
 *
 * Spawns a real @lydell/node-pty child through hostThroughPty: a fake Claude
 * script that logs its argv and every input line it receives (with its pid).
 * The host's real park policy runs on a short idle threshold, so each test
 * proves the actual wiring rather than a re-implementation:
 *   - an idle child is SIGKILLed while the host, socket and discovery file stay up;
 *   - a control-socket delivery resumes the SAME conversation (`--resume <id>`,
 *     via the real launcher's mintParkResumeArgs) and lands in the new child;
 *   - owner keystrokes typed while parked are held and replayed into the resumed child;
 *   - an in-TUI `/clear` (a newer transcript in the session's own config dir)
 *     switches the resume id;
 *   - a child with a live descendant is never parked, and `0` disables parking;
 *   - P-019: a resume that FAILS holds the delivery (and owner keystrokes) until a
 *     retry or a later trigger resumes, then delivers it exactly once;
 *   - D-003: a shutdown or host signal while parked ends the session without
 *     resuming the CLI, and a recycle reaching a parked host resumes first.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import net from 'node:net';
import { execPath } from 'node:process';
import { mintParkResumeArgs } from '../scripts/psu-launcher.mjs';
import {
  encodeControl,
  eventLogPathForOwner,
  hostThroughPty,
  metaPathFor,
  socketPathFor,
} from '../scripts/psu-pty-host.mjs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

/**
 * The fake Claude CLI. Every boot appends `{pid, argv}` to the argv log; every
 * input line appends `{pid, line}` to the input log, so a test can tell WHICH
 * child (the original or the resumed one) received a byte. It paints the
 * standalone composer glyph Claude's readiness detector keys on. With
 * `--with-descendant` it keeps a `sleep` child alive (an in-flight tool call).
 */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify({ pid: process.pid, argv }) + '\\n');
if (argv.includes('--with-descendant')) spawn('sleep', ['30'], { stdio: 'ignore' });
process.stdout.write('BOOT:' + process.pid + '\\n\\u276f\\n');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line) continue;
    fs.appendFileSync(process.env.FAKE_CLAUDE_INPUT_LOG, JSON.stringify({ pid: process.pid, line }) + '\\n');
    if (line.includes('QUIT')) process.exit(0);
    process.stdout.write('GOT:' + line + '\\n\\u276f\\n');
  }
});
setTimeout(() => process.exit(0), 30000);
`;

type HostEvent = Record<string, unknown> & { kind: string };
type ArgvEntry = { pid: number; argv: string[] };
type InputEntry = { pid: number; line: string };

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/**
 * Bound an await so a hang fails naming WHAT hung. Without it, a stuck socket or
 * host exit surfaces only as vitest's bare test timeout (reported as
 * "STACK_TRACE_ERROR"), which also masks an assertion that failed before the
 * `finally` quit hung (one such opaque red, 2026-10-06 09:21Z, WI-10006516).
 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function controlInject(
  sock: string,
  mode: 'turn' | 'raw' | 'shutdown' | 'recycle',
  data: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  let c: net.Socket | undefined;
  const closed = new Promise<void>((resolve) => {
    c = net.connect(sock, () => {
      c!.write(encodeControl({ mode, data, ownerId: basename(sock, '.sock'), ...extra }));
      c!.end();
    });
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
  return withDeadline(closed, 10_000, `the control socket to close after a ${mode} inject`).catch((error) => {
    c?.destroy();
    throw error;
  });
}

async function waitFor<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(25);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the session after a failed test body WITHOUT masking the body's error.
 * `finally { expect(await h.quit()).toBe(0) }` replaces the original assertion
 * failure with the quit's own timeout whenever the failure also wedged the host,
 * which is how a real P-019 defect first read as "timed out waiting for QUIT".
 */
async function quitAfterFailure(h: { quit(): Promise<number> }, error: unknown): Promise<unknown> {
  try {
    await h.quit();
  } catch (quitError) {
    if (error instanceof Error) {
      error.message += `\n(the quit afterwards also failed: ${(quitError as Error)?.message ?? String(quitError)})`;
    }
  }
  return error;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
});

function startParkHost({
  label,
  parkIdleMs = '400',
  extraArgs = [],
  configDir,
  extraEnv = {},
  hostOptions = {},
}: {
  label: string;
  parkIdleMs?: string;
  extraArgs?: string[];
  configDir?: (ownerId: string, root: string) => string;
  extraEnv?: Record<string, string>;
  hostOptions?: Record<string, unknown>;
}) {
  const ownerId = `su-park-${label}-itest-${process.pid}-${Math.floor(performance.now())}`;
  const root = mkdtempSync(join(tmpdir(), 'psu-park-itest-'));
  const script = join(root, 'fake-claude.cjs');
  writeFileSync(script, FAKE_CLAUDE);
  const argvLog = join(root, 'argv.jsonl');
  const inputLog = join(root, 'input.jsonl');
  const sock = socketPathFor(ownerId);
  const meta = metaPathFor(ownerId);
  const eventLog = eventLogPathForOwner(ownerId);
  let captured = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const io = {
    stdout: { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} },
    stdin,
  };
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAPERCUSP_SID: ownerId,
    PAPERCUSP_AGENT: 'claude',
    TERM: 'xterm-256color',
    FAKE_CLAUDE_ARGV_LOG: argvLog,
    FAKE_CLAUDE_INPUT_LOG: inputLog,
    PAPERCUSP_PSU_PARK_IDLE_MS: parkIdleMs,
    PAPERCUSP_PSU_PARK_RESUME_WAIT_MS: '5000',
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150',
    PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
    PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
    PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
    PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
    ...extraEnv,
  };
  // Never let the vitest worker's own session config dir leak in: the transcript
  // cross-check would read the REAL session's transcripts.
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir(ownerId, root);
  let exitCode: number | null = null;
  const done: Promise<number> = hostThroughPty({
    command: execPath,
    args: [script, '--session-id', SESSION_ID, ...extraArgs],
    cwd: root,
    env,
    ownerId,
    io,
    bridgeTty: false,
    activityPersistMs: 50,
    // The REAL launcher mint, exactly as psu-launcher wires it.
    mintParkResumeArgs: (a: string[], o: { agent?: string; nativeId?: string | null } = {}) =>
      mintParkResumeArgs(a, { agent: o.agent ?? 'claude', nativeId: o.nativeId ?? null }),
    onExit: (code: number) => {
      exitCode = code;
    },
    // Never probe a real operator pin from a test respawn.
    healOperatorPin: async () => null,
    ...hostOptions,
  });
  cleanups.push(() => {
    if (existsSync(eventLog)) unlinkSync(eventLog);
    rmSync(root, { recursive: true, force: true });
  });
  const events = () => readJsonl<HostEvent>(eventLog);
  return {
    ownerId,
    root,
    sock,
    meta,
    done,
    stdin,
    captured: () => captured,
    exitCode: () => exitCode,
    events,
    eventsOf: (kind: string) => events().filter((e) => e.kind === kind),
    argvLog: () => readJsonl<ArgvEntry>(argvLog),
    inputLog: () => readJsonl<InputEntry>(inputLog),
    readMeta: () => JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>,
    /** End the session: QUIT resumes a parked child first, then it exits 0. A hang
     *  names the host's own event trail, so the failure says WHERE it stuck. */
    async quit() {
      if (existsSync(sock)) await controlInject(sock, 'raw', 'QUIT\r');
      return withDeadline(done, 10_000, 'the host to exit after QUIT').catch((error: Error) => {
        const trail = events()
          .slice(-12)
          .map((e) => `${e.kind}${e.trigger ? `(${String(e.trigger)})` : ''}${e.reason ? `[${String(e.reason)}]` : ''}`)
          .join(' → ');
        const boots = readJsonl<ArgvEntry>(argvLog).length;
        const inputs = readJsonl<InputEntry>(inputLog).map((e) => `${e.pid}:${e.line}`).join(', ');
        throw new Error(`${error.message}; boots=${boots}; inputs=[${inputs}]; last events: ${trail}`);
      });
    },
  };
}

describe('psu process-free parking (P-017) — real pty round trip', () => {
  it(
    'parks an idle child, resumes the same conversation on a control-socket turn, and parks again',
    async () => {
      const h = startParkHost({ label: 'turn' });
      try {
        const parked1 = await waitFor(() => h.eventsOf('child-parked')[0], 'the first park');
        const [boot1] = h.argvLog();
        expect(boot1.argv).toEqual(['--session-id', SESSION_ID]);
        expect(parked1).toMatchObject({ childPid: boot1.pid, exited: true, nativeId: SESSION_ID, switchedFrom: null });

        // The host stays up while the CLI is gone: socket + discovery file live,
        // the discovery file advertises the park and never a dead pid.
        expect(existsSync(h.sock)).toBe(true);
        const meta = h.readMeta();
        expect(meta.parked).toBe(true);
        expect(typeof meta.parkedAt).toBe('number');
        expect(meta.ptyPid).toBeNull();
        await waitFor(() => !pidAlive(boot1.pid), 'the parked CLI to be gone');
        expect(h.captured()).toContain('[psu] Agent parked after');
        expect(h.exitCode()).toBeNull();

        // A control-socket turn resumes the SAME conversation and lands in the new child.
        await controlInject(h.sock, 'turn', 'WAKE_TOKEN_ONE');
        const got = await waitFor(
          () => h.inputLog().find((e) => e.line.includes('WAKE_TOKEN_ONE')),
          'the turn to reach the resumed child',
        );
        const boots = h.argvLog();
        expect(boots).toHaveLength(2);
        expect(boots[1].argv).toEqual(['--resume', SESSION_ID]);
        expect(got.pid).toBe(boots[1].pid);
        expect(got.pid).not.toBe(boot1.pid);
        const unparked = h.eventsOf('child-unparked')[0];
        expect(unparked).toMatchObject({
          trigger: 'control:turn',
          nativeId: SESSION_ID,
          childPid: boots[1].pid,
          promptReady: true,
        });
        expect(typeof unparked.parkedForMs).toBe('number');

        // Idle again → parked again, the resumed child this time.
        const parked2 = await waitFor(() => h.eventsOf('child-parked')[1], 'the second park');
        expect(parked2).toMatchObject({ childPid: boots[1].pid, nativeId: SESSION_ID });

        // A park is not a session end: nothing told the operator the session died.
        expect(h.exitCode()).toBeNull();

        // QUIT while parked resumes a third child (same id), which then exits.
        expect(await h.quit()).toBe(0);
        const finalBoots = h.argvLog();
        expect(finalBoots).toHaveLength(3);
        expect(finalBoots[2].argv).toEqual(['--resume', SESSION_ID]);
        expect(h.inputLog().at(-1)).toMatchObject({ pid: finalBoots[2].pid, line: 'QUIT' });
        expect(h.eventsOf('child-unparked')[1]).toMatchObject({ trigger: 'control:raw' });
        expect(h.exitCode()).toBe(0);
        expect(existsSync(h.sock)).toBe(false);
        expect(existsSync(h.meta)).toBe(false);
      } finally {
        await h.quit().catch(() => undefined);
      }
    },
    30_000,
  );

  it(
    'holds owner keystrokes typed while parked and replays them into the resumed child',
    async () => {
      const h = startParkHost({ label: 'owner' });
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        const [boot1] = h.argvLog();

        h.stdin.emit('data', Buffer.from('OWNER_TYPED_HELLO\r'));
        expect(h.captured()).toContain('[psu] Resuming the agent');

        const got = await waitFor(
          () => h.inputLog().find((e) => e.line.includes('OWNER_TYPED_HELLO')),
          'the held keystrokes to reach the resumed child',
        );
        const boots = h.argvLog();
        expect(boots[1].argv).toEqual(['--resume', SESSION_ID]);
        expect(got.pid).toBe(boots[1].pid);
        expect(got.pid).not.toBe(boot1.pid);
        expect(h.eventsOf('child-unparked')[0]).toMatchObject({ trigger: 'owner-input', nativeId: SESSION_ID });
        // Replayed exactly once.
        expect(h.inputLog().filter((e) => e.line.includes('OWNER_TYPED_HELLO'))).toHaveLength(1);
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );

  it(
    'resumes the newest transcript after an in-TUI /clear rotated the conversation id',
    async () => {
      const CLEARED_ID = '99999999-8888-4777-8666-555555555555';
      const h = startParkHost({
        label: 'clear',
        configDir: (ownerId, root) => {
          const dir = join(root, `claude-config-${ownerId}`);
          const projects = join(dir, 'projects', '-tmp-psu-park');
          mkdirSync(projects, { recursive: true });
          // The launch id's transcript, then a newer one written after /clear.
          writeFileSync(join(projects, `${SESSION_ID}.jsonl`), '{}\n');
          const later = join(projects, `${CLEARED_ID}.jsonl`);
          writeFileSync(later, '{}\n');
          const t = new Date(Date.now() + 5_000);
          utimesSync(later, t, t);
          return dir;
        },
      });
      try {
        const parked = await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        expect(parked).toMatchObject({ nativeId: CLEARED_ID, switchedFrom: SESSION_ID });
        await controlInject(h.sock, 'turn', 'AFTER_CLEAR');
        await waitFor(() => h.inputLog().find((e) => e.line.includes('AFTER_CLEAR')), 'the post-/clear turn');
        expect(h.argvLog()[1].argv).toEqual(['--resume', CLEARED_ID]);
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );

  it(
    'never parks a child with a live descendant (an in-flight tool call) and reports why',
    async () => {
      const h = startParkHost({ label: 'descendant', extraArgs: ['--with-descendant'] });
      try {
        const deferred = await waitFor(
          () => h.eventsOf('child-park-deferred').find((e) => e.reason === 'child-has-descendants'),
          'the descendant deferral',
        );
        expect(deferred.descendants).toBeGreaterThan(0);
        // Well past the threshold, still not parked.
        await sleep(800);
        expect(h.eventsOf('child-parked')).toEqual([]);
        expect(h.readMeta().parked ?? false).toBe(false);
        expect(h.readMeta().ptyPid).toBe(h.argvLog()[0].pid);
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );

  it(
    'PAPERCUSP_PSU_PARK_IDLE_MS=0 is the kill-switch: the idle child is left running',
    async () => {
      const h = startParkHost({ label: 'off', parkIdleMs: '0' });
      try {
        await waitFor(() => h.argvLog()[0], 'the boot');
        await sleep(1_200);
        expect(h.eventsOf('child-parked')).toEqual([]);
        expect(h.eventsOf('child-park-deferred')).toEqual([]);
        expect(pidAlive(h.argvLog()[0].pid)).toBe(true);
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );
});

/**
 * A pty spawn that fails on exactly its Nth call (1 = the launch, 2 = the first
 * resume) the way fork does under memory pressure, and delegates to the real
 * spawn otherwise. The pressure that makes parking worthwhile is the same
 * pressure that can make a resume fail.
 */
function failNthSpawn(n: number) {
  let calls = 0;
  return (
    file: string,
    argv: string[],
    options: object,
    realSpawn: (file: string, argv: string[], options: object) => unknown,
  ) => {
    calls += 1;
    if (calls === n) throw Object.assign(new Error('forkpty(3) failed.'), { code: 'EAGAIN' });
    return realSpawn(file, argv, options);
  };
}

describe('psu process-free parking (P-019) — a failed resume never loses a delivery', () => {
  it(
    'holds the control-socket turn when the resume fails, and the retry delivers it exactly once',
    async () => {
      const h = startParkHost({
        label: 'unpark-retry',
        extraEnv: { PAPERCUSP_PSU_PARK_UNPARK_RETRY_MS: '400' },
        hostOptions: { spawnPty: failNthSpawn(2) },
      });
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        const [boot1] = h.argvLog();

        await controlInject(h.sock, 'turn', 'HELD_TURN_TOKEN');
        const failed = await waitFor(() => h.eventsOf('child-unpark-failed')[0], 'the failed resume');
        // hostErrorEvidence records the error's name and code, never its message.
        expect(failed).toMatchObject({ trigger: 'control:turn', reason: 'spawn-failed', errorCode: 'EAGAIN' });
        expect(await waitFor(() => h.eventsOf('parked-delivery-held')[0], 'the held delivery')).toMatchObject({
          mode: 'turn',
          reason: 'spawn-failed',
          held: 1,
        });

        // The retry resumes the same conversation and the held turn lands in it.
        const got = await waitFor(
          () => h.inputLog().find((e) => e.line.includes('HELD_TURN_TOKEN')),
          'the held turn to reach the retried resume',
        );
        const boots = h.argvLog();
        // The failed spawn never booted anything; the retry is the second boot.
        expect(boots).toHaveLength(2);
        expect(boots[1].argv).toEqual(['--resume', SESSION_ID]);
        expect(got.pid).toBe(boots[1].pid);
        expect(got.pid).not.toBe(boot1.pid);
        expect(h.eventsOf('child-unparked')[0]).toMatchObject({
          trigger: 'retry',
          nativeId: SESSION_ID,
          promptReady: true,
        });
        const kinds = h.events().map((e) => e.kind);
        expect(kinds.indexOf('parked-delivery-held')).toBeLessThan(kinds.indexOf('child-unparked'));
        // Exactly once, and the failure did not end the session.
        await sleep(300);
        expect(h.inputLog().filter((e) => e.line.includes('HELD_TURN_TOKEN'))).toHaveLength(1);
        expect(h.exitCode()).toBeNull();
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );

  it(
    'a later owner keystroke resumes after a failed resume and delivers the held turn with it',
    async () => {
      const h = startParkHost({
        label: 'unpark-owner',
        // Far enough out that only the keystroke can be the resume trigger.
        extraEnv: { PAPERCUSP_PSU_PARK_UNPARK_RETRY_MS: '60000' },
        hostOptions: { spawnPty: failNthSpawn(2) },
      });
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        await controlInject(h.sock, 'turn', 'HELD_BEHIND_FAILURE');
        await waitFor(() => h.eventsOf('parked-delivery-held')[0], 'the held delivery');
        // Held, not dropped and not written anywhere: still parked, nothing received.
        expect(h.readMeta().parked).toBe(true);
        expect(h.readMeta().ptyPid).toBeNull();
        expect(h.inputLog()).toEqual([]);

        h.stdin.emit('data', Buffer.from('OWNER_AFTER_FAILURE\r'));
        await waitFor(() => {
          const lines = h.inputLog().map((e) => e.line);
          return (
            lines.some((l) => l.includes('OWNER_AFTER_FAILURE')) && lines.some((l) => l.includes('HELD_BEHIND_FAILURE'))
          );
        }, 'the keystrokes and the held turn to reach the resumed child');
        const boots = h.argvLog();
        expect(boots).toHaveLength(2);
        await sleep(300);
        for (const token of ['OWNER_AFTER_FAILURE', 'HELD_BEHIND_FAILURE']) {
          const rows = h.inputLog().filter((e) => e.line.includes(token));
          expect(rows).toHaveLength(1);
          expect(rows[0].pid).toBe(boots[1].pid);
        }
        expect(h.eventsOf('child-unparked')[0]).toMatchObject({ trigger: 'owner-input', nativeId: SESSION_ID });
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    30_000,
  );
});

describe('psu process-free parking (D-003) — session lifecycle while parked', () => {
  it(
    'a shutdown while parked ends the session cleanly without resuming the CLI',
    async () => {
      const h = startParkHost({ label: 'shutdown', extraEnv: { PAPERCUSP_LAUNCHED_BY: 'psu-park-itest' } });
      let ended = false;
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        await controlInject(h.sock, 'shutdown', 'itest wind-down', { force: true });
        const code = await withDeadline(h.done, 10_000, 'the host to exit after a shutdown while parked');
        ended = true;
        expect(code).toBe(0);
        expect(h.exitCode()).toBe(0);
        expect(h.eventsOf('shutdown-accepted')).toHaveLength(1);
        // No CLI was started just to be stopped again.
        expect(h.argvLog()).toHaveLength(1);
        expect(h.eventsOf('child-unparked')).toEqual([]);
        expect(h.eventsOf('child-unpark-failed')).toEqual([]);
        expect(existsSync(h.sock)).toBe(false);
        expect(existsSync(h.meta)).toBe(false);
      } finally {
        if (!ended) await h.quit().catch(() => undefined);
      }
    },
    30_000,
  );

  it(
    'a host signal while parked tears the session down without resuming the CLI',
    async () => {
      const signals = new EventEmitter();
      const h = startParkHost({ label: 'signal', hostOptions: { signalSource: signals } });
      let ended = false;
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park');
        signals.emit('SIGTERM', 'SIGTERM');
        await withDeadline(h.done, 10_000, 'the host to exit after SIGTERM while parked');
        ended = true;
        expect(h.eventsOf('host-teardown')[0]).toMatchObject({ via: 'signal', signal: 'SIGTERM' });
        expect(h.argvLog()).toHaveLength(1);
        expect(h.eventsOf('child-unparked')).toEqual([]);
        expect(existsSync(h.sock)).toBe(false);
        expect(existsSync(h.meta)).toBe(false);
      } finally {
        if (!ended) await h.quit().catch(() => undefined);
      }
    },
    30_000,
  );

  it(
    'a recycle that reaches a parked host resumes first, then respawns and carries its turn',
    async () => {
      // A longer threshold so the recycled child is not re-parked mid-carry.
      const h = startParkHost({ label: 'recycle', parkIdleMs: '1500' });
      try {
        await waitFor(() => h.eventsOf('child-parked')[0], 'the park', 10_000);
        await controlInject(h.sock, 'recycle', 'RECYCLE_CARRY_TOKEN');
        const got = await waitFor(
          () => h.inputLog().find((e) => e.line.includes('RECYCLE_CARRY_TOKEN')),
          'the recycle carry to land',
          15_000,
        );
        const boots = h.argvLog();
        // launch → resume (same conversation) → the recycle's own respawn.
        expect(boots).toHaveLength(3);
        expect(boots[1].argv).toEqual(['--resume', SESSION_ID]);
        expect(got.pid).toBe(boots[2].pid);
        expect(h.eventsOf('child-unparked')[0]).toMatchObject({ trigger: 'control:recycle', nativeId: SESSION_ID });
        expect(h.inputLog().filter((e) => e.line.includes('RECYCLE_CARRY_TOKEN'))).toHaveLength(1);
        expect(h.exitCode()).toBeNull();
      } catch (error) {
        throw await quitAfterFailure(h, error);
      }
      expect(await h.quit()).toBe(0);
    },
    45_000,
  );
});
