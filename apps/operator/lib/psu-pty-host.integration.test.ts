// @vitest-environment node
/**
 * psu-pty-host.integration.test.ts — the real managed-pty round-trip
 * (turn-lifecycle-control Phase 3, P-012/P-014/P-015): spawn a child through the
 * host, inject via the control socket, assert it lands in the child's stdin, and
 * assert the socket + discovery file are created on start and cleaned up on exit.
 * Spawns a real @lydell/node-pty subprocess, so it's an integration test.
 */
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execPath } from 'node:process';
import { spawn } from 'node:child_process';
import {
  hostThroughPty,
  socketPathFor,
  metaPathFor,
  eventLogPathForOwner,
  encodeControl,
  KICKOFF_PROOF_PATH_ENV,
  KICKOFF_PROOF_TOKEN_ENV,
  readManagedKickoffFile,
  ptyWriteChunks,
  findNativeTranscriptMarker,
  waitForNativeTranscriptMarker,
  leadingTurnOriginMarker,
  tagSessionPortTurn,
  startupOutputReady,
  freshChildPromptReady,
  killPtyProcessTree,
  handoffPathFor,
  MAX_CONTROL_PAYLOAD_BYTES,
  PSU_PTY_DIR,
} from '../scripts/psu-pty-host.mjs';
// The REAL operator-side force-interrupt leg (turn-lifecycle-control Phase 4
// pty-force, reused by e8630's turn:interrupt tool). Importing the published
// subpath keeps this an integration test of the actual chain, not a re-impl.
import { interruptViaPty, findLiveHost } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

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

describe('managed-pty integration evidence isolation', () => {
  it('redirects host lifecycle evidence away from the live operator corpus', () => {
    const liveDir = join(homedir(), '.papercusp', 'psu-pty');
    expect(process.env.PAPERCUSP_PSU_PTY_DIR).toBeTruthy();
    expect(PSU_PTY_DIR).toBe(process.env.PAPERCUSP_PSU_PTY_DIR);
    expect(PSU_PTY_DIR).not.toBe(liveDir);
  });
});

describe('Codex resumed and forked quota history (EI-22609012864215464, EI-22800121604015331)', () => {
  it.each([
    ['resume', 'control'],
    ['resume', 'kickoff'],
    ['fork', 'control'],
    ['fork', 'kickoff'],
  ] as const)('%s %s submits after a replayed wall and still blocks a new wall', async (subcommand, route) => {
    const ownerId = `su-quota-replay-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const meta = metaPathFor(ownerId);
    const { captured, io } = fakeIo();
    const childCode =
      "process.stdout.write(\"You've hit your usage limit.\\n60% context left\\n\");" +
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
      "if(line==='QUIT')process.exit(0);" +
      "if(line==='WALL')process.stdout.write(\"You've hit your usage limit.\\n\");" +
      "else process.stdout.write('ECHO:'+line+'\\n');}});" +
      'setTimeout(()=>process.exit(0),12000);';
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode, subcommand, '11111111-1111-4111-8111-111111111111'],
      cwd: '/tmp',
      env: {
        ...process.env,
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      signalSource: new EventEmitter(),
      kickoff: route === 'kickoff' ? 'RECOVERED' : null,
    });
    try {
      await vi.waitFor(() => expect(captured()).toContain('60% context left'), { timeout: 3000 });
      if (route === 'control') await controlInject(sock, 'turn', 'RECOVERED');
      await vi.waitFor(() => expect(captured()).toContain('ECHO:RECOVERED'), { timeout: 3000 });
      expect(JSON.parse(readFileSync(meta, 'utf8')).quotaBlocked).toBe(false);

      await rawInject(sock, 'WALL\n');
      await vi.waitFor(() => expect(JSON.parse(readFileSync(meta, 'utf8')).quotaBlocked).toBe(true));
      await controlInject(sock, 'turn', 'SHOULD-NOT-RUN');
      await vi.waitFor(() => expect(readFileSync(eventLogPathForOwner(ownerId), 'utf8'))
        .toContain('turn-deferred-quota-blocked'));
      expect(captured()).not.toContain('ECHO:SHOULD-NOT-RUN');
    } finally {
      if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
      await done;
    }
  }, 18000);
});

// EI-18683281603125383: the server (psu-pty-host.mjs, WI-5872/EI-18676244363359331)
// now writes a JSON-line ACK/NACK back on the connection (`allowHalfOpen:true`)
// BEFORE calling `conn.end()`. A client that never attaches a 'data' listener
// (nor calls .resume()/.pipe()) leaves its Readable side PAUSED — Node only
// advances a paused stream to 'end' once something starts consuming it — so
// with unconsumed ACK bytes sitting in the socket's internal buffer, 'end' (and
// therefore 'close') never fires. That silently hung every helper below
// forever the moment the server started acking (confirmed independent of any
// pty/vitest/CPU-load involvement via a minimal bare `net` repro: a plain
// allowHalfOpen server that writes+ends after a client with no 'data' listener
// never sees 'close', deterministically, in <1s). Draining the payload (even
// via a no-op 'data' handler) puts the stream in flowing mode so 'end'/'close'
// fire normally; these helpers only ever cared about "did the connection settle",
// never the ACK payload itself, so discarding it is the correct minimal fix —
// production's own injectIntoHost() (psu-pty-discovery.ts) already reads this
// same ACK for real and was unaffected.
function rawInject(sock: string, data: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'raw', data }));
      c.end();
    });
    c.on('data', () => {});
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
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

function envelopeInject(sock: string, envelope: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(JSON.stringify({ v: 1, ...envelope }));
      c.end();
    });
    c.on('data', () => {});
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// WI-2339 defect #2 (2026-07-04) added a process-IDENTITY check to findLiveHost /
// interruptViaPty: the discovered pid's /proc/<pid>/cmdline must match
// /psu-(launcher|pty-host)/, so a recycled pid held by an unrelated process can't
// masquerade as a live host. This file hosts the pty IN-PROCESS (hostThroughPty runs
// inside the vitest worker, which records `pid: process.pid` — the WORKER's own pid,
// whose cmdline is the vitest runner, not a psu-launcher/psu-pty-host process), so a
// bare findLiveHost()/interruptViaPty() call here fails that check post-WI-2339 even
// though the discovered host is a perfectly valid stand-in for this test — this was a
// real, deterministic (not flaky) regression: EI-7725. psu-pty-discovery.test.ts's own
// `ID_OK` seam is the documented fix (see findLiveHost's doc comment: "A test writing
// `process.pid` as a live-host stand-in injects `() => true`"), already applied in the
// sibling psu-pty-host-turn.integration.test.ts — mirrored here.
const ID_OK = { verifyIdentity: () => true } as const;

describe('session-port managed seed + native persistence helpers', () => {
  it('waits for OMP backend startup rather than treating terminal-query noise as editor readiness', () => {
    expect(startupOutputReady('omp', '\x1b[6n\x1b[?25l')).toBe(false);
    expect(startupOutputReady('omp', '\x1b[2J omp v16.3.3 \x1b[0m')).toBe(true);
  });

  // WI-4943: a live Claude→Codex port wrote its managed seed while Codex was
  // still typewriter-animating its onboarding "Tip: ..." line (and, sometimes,
  // an MCP-startup warning typed the same way) — long before the composer
  // existed. The PTY host's OLD codex behavior (any non-empty output ⇒ ready)
  // treated that animation's very first byte, or any mid-typing frame, as
  // startup-ready. Verified against a real captured `codex` v0.146.0 PTY boot
  // (character-by-character cursor-reposition repaint) and the shipped
  // `@openai/codex-linux-x64` binary's own embedded composer-footer strings
  // ("NN% context left" is chrome the TUI only paints once its editable input
  // line is installed).
  it('waits for the Codex composer footer rather than its first output byte or onboarding-tip animation', () => {
    // The very first byte a fresh Codex TUI emits is bare terminal-capability
    // probe noise, not proof of readiness.
    expect(startupOutputReady('codex', '\x1b[6n')).toBe(false);
    // A mid-animation frame of the real onboarding-tip typewriter effect (one
    // character per repaint, via save/restore-cursor + line-clear escapes) —
    // still not the composer.
    const tipAnimationFrame =
      '\x1b[?2026h\x1b[1;1H\x1b[2K\x1b[1m  T\x1b[0m\x1b7\x1b8\x1b[1B\x1b[1G\x1b[2K\x1b[1m  i\x1b[0m' +
      '\x1b7\x1b8\x1b[1B\x1b[1G\x1b[2K\x1b[1m  p\x1b[0m\x1b[?2026l';
    expect(startupOutputReady('codex', tipAnimationFrame)).toBe(false);
    // A quiet gap can also open mid-animation, right after the tip finishes and
    // before Codex resumes typing an MCP-startup warning the same way — still
    // not the composer, and exactly the pause an ordinary quiescence check
    // could misread as "settled at a prompt".
    expect(startupOutputReady('codex', '\x1b[1m  together.\x1b[0m')).toBe(false);
    // The composer's live context-budget readout is real chrome, not user
    // content — present only once the editable input line exists.
    expect(startupOutputReady('codex', '\x1b[38;5;244m100\x1b[0m% context left')).toBe(true);
    expect(startupOutputReady('codex', ' 62%  context left ')).toBe(true);
  });

  it('recognizes a Claude composer glyph while rejecting startup noise and recovery-menu rows', () => {
    expect(freshChildPromptReady('claude', '\x1b[2J spinner / loading')).toBe(false);
    expect(freshChildPromptReady('claude', '❯ 1. Resume from summary')).toBe(false);
    expect(freshChildPromptReady('claude', '\x1b[2K\n❯\n')).toBe(true);
    expect(freshChildPromptReady('codex', '\n❯\n')).toBe(false);
  });

  it('auto-advances the headless Claude theme and Security notes prompts exactly once', async () => {
    const ownerId = `su-headless-onboarding-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const { captured, io } = fakeIo();
    const childCode =
      "let advances=0;" +
      "process.stdout.write('Choose your preferred theme: Dark mode\\n');" +
      "process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data',d=>{const count=(d.match(/[\\r\\n]/g)||[]).length;for(let i=0;i<count;i++){advances++;process.stdout.write('AUTO_CR_'+advances+'\\n');if(advances===1)process.stdout.write('Security notes\\nPress Enter to continue\\n');if(advances===2){process.stdout.write('ONBOARDING_READY\\n');setTimeout(()=>process.exit(0),50);}}});";
    const done = hostThroughPty({
      command: execPath,
      args: ['-e', childCode],
      cwd: '/tmp',
      env: {
        ...process.env,
        PAPERCUSP_SID: ownerId,
        PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_PSU_HEADLESS: '1',
        PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS: '1000',
        PAPERCUSP_FLEET_BG: '',
        PAPERCUSP_FLEET_FG: '',
        PAPERCUSP_FLEET_CURSOR: '',
        TERM: 'xterm-256color',
      },
      ownerId,
      io,
      bridgeTty: false,
      onExit: () => {},
    });

    const deadline = Date.now() + 5_000;
    while (!captured().includes('ONBOARDING_READY') && Date.now() < deadline) await sleep(10);
    expect(captured()).toContain('ONBOARDING_READY');
    expect((captured().match(/AUTO_CR_1/g) || []).length).toBe(1);
    expect((captured().match(/AUTO_CR_2/g) || []).length).toBe(1);
    expect(await done).toBe(0);
    expect(existsSync(sock)).toBe(false);
  }, 10_000);

  it('signals the forkpty process group and retains a direct-child fallback', () => {
    const groupKill = vi.fn();
    const directKill = vi.fn();
    expect(killPtyProcessTree({ pid: 4242, kill: directKill }, 'SIGHUP', groupKill)).toBe(true);
    if (process.platform !== 'win32') expect(groupKill).toHaveBeenCalledWith(-4242, 'SIGHUP');
    expect(directKill).toHaveBeenCalledWith('SIGHUP');
  });

  it('securely reads a 0600 seed and rejects a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-port-seed-'));
    try {
      const hash = 'a'.repeat(64);
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `history\n[PAPERCUSP SESSION PORT CHECKSUM ${hash}]\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      expect(readManagedKickoffFile(seed, hash)).toMatchObject({ renderedHash: hash });
      const link = join(root, 'link.md');
      symlinkSync(seed, link);
      expect(() => readManagedKickoffFile(link, hash)).toThrow(/regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('chunks the maximum-style UTF-8 paste without changing a code point or exceeding 64KiB/write', () => {
    const text = '😀'.repeat(MAX_CONTROL_PAYLOAD_BYTES / 4); // exactly 8 MiB UTF-8
    const chunks = ptyWriteChunks(text);
    expect(chunks.join('')).toBe(text);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_CONTROL_PAYLOAD_BYTES);
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk, 'utf8')))).toBeLessThanOrEqual(64 * 1024);
  });

  it('stamps a dedicated verified session-port provenance row before injection', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-port-provenance-'));
    try {
      const tagged = tagSessionPortTurn(
        'history',
        'su-port-proof',
        { PAPERCUSP_TURN_PROVENANCE_DIR: root } as any,
        1234,
      );
      expect(tagged).toMatch(/^⟦turn-origin:session-port nonce:[a-f0-9]{16}⟧\nhistory$/);
      const row = JSON.parse(readFileSync(join(root, 'su-port-proof.jsonl'), 'utf8'));
      expect(row).toMatchObject({ sid: 'su-port-proof', origin: 'session-port', ts: 1234 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only the exact marker in the target Claude/Codex/OMP native JSONL roots', async () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-port-native-'));
    const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${'b'.repeat(64)}]`;
    try {
      const codexDir = join(home, 'codex-target', 'sessions', '2026', '07');
      mkdirSync(codexDir, { recursive: true });
      const codexFile = join(codexDir, 'rollout.jsonl');
      writeFileSync(codexFile, `${JSON.stringify({ role: 'user', text: marker })}\n`);
      expect(findNativeTranscriptMarker({
        agent: 'codex', env: { CODEX_HOME: join(home, 'codex-target') }, marker, sinceMs: Date.now(), home,
      })).toBe(codexFile);

      const ompDir = join(home, '.omp-target', 'agent', 'sessions', 'project');
      mkdirSync(ompDir, { recursive: true });
      const ompFile = join(ompDir, 'thread.jsonl');
      writeFileSync(ompFile, `${JSON.stringify({ type: 'message', text: marker })}\n`);
      const proof = await waitForNativeTranscriptMarker({
        agent: 'omp', env: { PI_CONFIG_DIR: '.omp-target' }, marker, sinceMs: Date.now(), home, timeoutMs: 100, pollMs: 5,
      });
      expect(proof).toEqual({ persisted: true, nativeRef: ompFile });
      expect(findNativeTranscriptMarker({
        agent: 'omp', env: { PI_CONFIG_DIR: '.omp-target' }, marker: `${marker}-wrong`, sinceMs: Date.now(), home,
      })).toBeNull();

      const claudeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const claudeDir = join(home, 'claude-target', 'projects', '-tmp');
      mkdirSync(claudeDir, { recursive: true });
      const claudeFile = join(claudeDir, `${claudeId}.jsonl`);
      const carryMarker = '⟦turn-origin:self-compaction nonce:0123456789abcdef⟧';
      writeFileSync(claudeFile, `${JSON.stringify({ type: 'user', message: { content: carryMarker } })}\n`);
      expect(leadingTurnOriginMarker(`${carryMarker}\nContinue where you left off`)).toBe(carryMarker);
      expect(leadingTurnOriginMarker(`history before ${carryMarker}`)).toBeNull();
      expect(findNativeTranscriptMarker({
        agent: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, 'claude-target') },
        marker: carryMarker,
        nativeId: claudeId,
        sinceMs: Date.now(),
        home,
      })).toBe(claudeFile);
      expect(findNativeTranscriptMarker({
        agent: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, 'claude-target') },
        marker: carryMarker,
        nativeId: 'ffffffff-1111-4222-8333-444444444444',
        sinceMs: Date.now(),
        home,
      })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('hostThroughPty real round-trip', () => {
  it(
    'refuses a second live host before spawn/unlink and leaves the original socket injectable',
    async () => {
      const ownerId = `su-duplicate-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      mkdirSync(PSU_PTY_DIR, { recursive: true });
      const originalCode = [
        "const fs=require('node:fs');const net=require('node:net');",
        `const sock=${JSON.stringify(sock)},meta=${JSON.stringify(meta)},owner=${JSON.stringify(ownerId)};`,
        "try{fs.unlinkSync(sock)}catch{}",
        "const server=net.createServer(c=>{let b='';c.setEncoding('utf8');c.on('data',d=>{b+=d;if(b.includes('PROBE\\n')){c.end('ORIGINAL-ACK\\n')}if(b.includes('QUIT\\n')){c.end('BYE\\n');server.close(()=>{try{fs.unlinkSync(meta)}catch{};process.exit(0)})}})});",
        "server.listen(sock,()=>{fs.writeFileSync(meta,JSON.stringify({ownerId:owner,pid:process.pid,sock}));process.stdout.write('READY\\n')});",
        "setTimeout(()=>process.exit(3),15000);",
      ].join('');
      const original = spawn(
        execPath,
        ['-e', originalCode, 'psu-pty-host-decoy'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('original host did not become ready')),
            5_000,
          );
          original.stdout!.setEncoding('utf8');
          original.stdout!.on('data', (data) => {
            if (String(data).includes('READY')) {
              clearTimeout(timer);
              resolve();
            }
          });
          original.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`original host exited early (${code})`));
          });
        });

        let onSpawnCalls = 0;
        expect(() =>
          hostThroughPty({
            command: execPath,
            args: ['-e', 'setTimeout(()=>{},10000)'],
            cwd: '/tmp',
            env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
            ownerId,
            io: fakeIo().io,
            bridgeTty: false,
            onSpawn: () => {
              onSpawnCalls += 1;
            },
            onExit: () => {},
          }),
        ).toThrow(new RegExp(`refusing duplicate startup.*${ownerId}.*${original.pid}`));
        expect(onSpawnCalls).toBe(0);
        expect(existsSync(sock)).toBe(true);
        expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(original.pid);

        const ack = await new Promise<string>((resolve, reject) => {
          let text = '';
          const client = net.createConnection(sock);
          client.setEncoding('utf8');
          client.on('connect', () => client.write('PROBE\n'));
          client.on('data', (data) => {
            text += data;
          });
          client.on('end', () => resolve(text));
          client.on('error', reject);
        });
        expect(ack).toContain('ORIGINAL-ACK');
      } finally {
        if (original.exitCode === null) {
          await new Promise<void>((resolve) => {
            const client = net.createConnection(sock, () => client.write('QUIT\n'));
            client.on('data', () => {});
            client.on('end', resolve);
            client.on('error', () => {
              original.kill('SIGKILL');
              resolve();
            });
          });
          await new Promise<void>((resolve) => original.once('exit', () => resolve()));
        }
        try { unlinkSync(sock); } catch { /* server close may already unlink it */ }
        try { unlinkSync(meta); } catch { /* child cleanup normally removes it */ }
      }
    },
    20_000,
  );
  it(
    'selects Claude resume-compaction summary before delivering a scripted kickoff',
    async () => {
      const ownerId = `su-resume-compaction-itest-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      const childCode = [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.setRawMode?.(true);",
        "let selected=0,input='',kickoffReceived=false;",
        "setTimeout(()=>{process.stdout.write('\\x1b[31mAutocompact is th');setTimeout(()=>process.stdout.write(\"rashing\\x1b[0m\\n1. Resume from summary (recommended)\\n2. Resume full session as-is\\n3. Don't ask again\\n\"),30);},20);",
        "process.stdin.on('data',d=>{input+=d;if(!selected&&input.includes('KICKOFF')){process.stdout.write('EARLY_KICKOFF\\n');process.exit(3);return;}if(!selected&&input.includes('\\r')){selected++;input='';process.stdout.write('RESUME_SELECTED\\n\\n\\x1b[32m❯\\x1b[0m \\n');return;}if(selected&&!kickoffReceived&&input.includes('KICKOFF')){kickoffReceived=true;process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),100);}});",
        "setTimeout(()=>process.exit(2),5000);",
      ].join('');
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS: '1000',
          PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS: '1000',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '2000',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '500',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          // The synthetic child exits shortly after acknowledging the kickoff;
          // keep the submit verifier from mistaking that intentional teardown
          // for a swallowed Enter while this test checks recovery ordering.
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '500',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        kickoff: 'KICKOFF',
        onExit: () => undefined,
      });
      try {
        const deadline = Date.now() + 4_000;
        while (!captured().includes('KICKOFF_RECEIVED') && Date.now() < deadline) await sleep(10);
        expect(captured()).not.toContain('EARLY_KICKOFF');
        expect(captured()).toContain('RESUME_SELECTED');
        expect(captured()).toContain('KICKOFF_RECEIVED');
        expect(await done).toBe(0);
      } finally {
        // The child has a bounded self-exit; this cleanup only removes the
        // owner-specific discovery artifacts if an assertion fails early.
        await done;
      }
    },
    10_000,
  );

  it(
    'publishes a plain-launch native kickoff proof into the parent receipt',
    async () => {
      if (typeof process.getuid !== 'function') return;
      const root = mkdtempSync(join(tmpdir(), 'psu-kickoff-proof-itest-'));
      const ownerId = `su-kickoff-proof-itest-${process.pid}-${Math.floor(performance.now())}`;
      const proofPath = join(root, 'kickoff-proof.json');
      const token = 'c'.repeat(48);
      const codexHome = join(root, 'codex-home');
      const nativeFile = join(codexHome, 'sessions', '2026', '08', 'rollout.jsonl');
      const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
      const kickoff = `${marker}\nBEGIN_PROOF_KICKOFF`;
      writeFileSync(proofPath, '', { mode: 0o600 });
      chmodSync(proofPath, 0o600);
      const { captured, io } = fakeIo();
      const childCode = [
        "const fs=require('fs'),path=require('path');",
        "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
        "let b='';process.stdout.write('62% context left\\n');",
        "process.stdin.on('data',d=>{b+=d;if(!b.includes('BEGIN_PROOF_KICKOFF'))return;fs.mkdirSync(path.dirname(process.env.NATIVE_FILE),{recursive:true});fs.writeFileSync(process.env.NATIVE_FILE,JSON.stringify({role:'user',text:process.env.KICKOFF_MARKER})+'\\n');process.stdout.write('KICKOFF_RECEIVED\\n');setTimeout(()=>process.exit(0),50);});",
        'setTimeout(()=>process.exit(2),5000);',
      ].join('');
      let done;
      try {
        done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...process.env,
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'codex',
            CODEX_HOME: codexHome,
            NATIVE_FILE: nativeFile,
            KICKOFF_MARKER: marker,
            [KICKOFF_PROOF_PATH_ENV]: proofPath,
            [KICKOFF_PROOF_TOKEN_ENV]: token,
            PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '100',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
            PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '20',
            PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '20',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '3',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
            TERM: 'xterm-256color',
          },
          ownerId,
          io,
          bridgeTty: false,
          kickoff,
          onExit: () => undefined,
        });
        const deadline = Date.now() + 5_000;
        while (readFileSync(proofPath, 'utf8').length === 0 && Date.now() < deadline) await sleep(10);
        expect(captured()).toContain('KICKOFF_RECEIVED');
        expect(JSON.parse(readFileSync(proofPath, 'utf8'))).toEqual({
          token,
          persisted: true,
          nativeRef: nativeFile,
          reason: null,
        });
        expect(await done).toBe(0);
      } finally {
        await done?.catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'acknowledges a managed session-port seed only after the target-native transcript persists its exact marker',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-port-host-'));
      const agentDir = join(root, 'omp-agent');
      const sessionsDir = join(agentDir, 'sessions', 'project');
      mkdirSync(sessionsDir, { recursive: true });
      const nativeFile = join(sessionsDir, 'thread.jsonl');
      const hash = 'c'.repeat(64);
      const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${hash}]`;
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `ported history\n${marker}\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      const ownerId = `su-port-itest-${process.pid}-${Math.floor(performance.now())}`;
      const { io } = fakeIo();
      const onKickoffPersisted = vi.fn(async () => undefined);
      const childCode = [
        "const fs=require('fs'),path=require('path');",
        "process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);",
        "let ready=false,b='',wrote=false;process.stdout.write('\\x1b[6n');setTimeout(()=>{ready=true;process.stdout.write('omp v16.3.3\\nREADY\\n');},400);",
        "process.stdin.on('data',d=>{b+=d;if(!wrote&&b.includes(process.env.PORT_MARKER)&&(b.includes('\\r')||b.includes('\\n'))){if(!ready){process.stdout.write('EARLY-SEED\\n');process.exit(3);return;}wrote=true;fs.mkdirSync(path.dirname(process.env.PORT_NATIVE_FILE),{recursive:true});fs.writeFileSync(process.env.PORT_NATIVE_FILE,JSON.stringify({type:'message',role:'user',text:process.env.PORT_MARKER})+'\\n');process.stdout.write('WORKING\\n');setTimeout(()=>process.exit(0),1200);}});",
        "setTimeout(()=>process.exit(2),10000);",
      ].join('');
      try {
        const done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...process.env,
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'omp',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
            PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
            PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
            PAPERCUSP_TURN_PROVENANCE_DIR: join(root, 'provenance'),
            PI_CODING_AGENT_DIR: agentDir,
            PORT_MARKER: marker,
            PORT_NATIVE_FILE: nativeFile,
            TERM: 'xterm-256color',
          },
          ownerId,
          advSessionId: 999,
          io,
          bridgeTty: false,
          kickoffFile: seed,
          sessionPort: { renderedHash: hash },
          onKickoffPersisted,
          nativePersistenceTimeoutMs: 3000,
          onExit: () => undefined,
        });
        const deadline = Date.now() + 5000;
        while (onKickoffPersisted.mock.calls.length === 0 && Date.now() < deadline) await sleep(25);
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        expect(onKickoffPersisted.mock.calls[0]?.[0]).toEqual({
          persisted: true,
          renderedHash: hash,
          nativeRef: nativeFile,
        });
        await done;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    'external SIGTERM tears down the whole OMP-style process group and reaps detached scope before child exit',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-port-sigint-'));
      const hash = 'd'.repeat(64);
      const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${hash}]`;
      const seed = join(root, 'seed.md');
      writeFileSync(seed, `ported history\n${marker}\n`, { mode: 0o600 });
      chmodSync(seed, 0o600);
      const ownerId = `su-port-sigint-${process.pid}-${Math.floor(performance.now())}`;
      const { captured, io } = fakeIo();
      const signals = new EventEmitter();
      const onKickoffPersisted = vi.fn(async () => undefined);
      const reapScopeResidue = vi.fn(() => ({ killedPids: [4242], failedPids: [] }));
      const childCode = [
        "const {spawn}=require('child_process');",
        "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        "process.stdout.write('GRAND:'+g.pid+'\\nomp v16.3.3\\n');",
        "process.stdin.setRawMode?.(true);process.stdin.resume();setInterval(()=>{},1000);",
      ].join('');
      try {
        const done = hostThroughPty({
          command: execPath,
          args: ['-e', childCode],
          cwd: root,
          env: {
            ...process.env,
            PAPERCUSP_SID: ownerId,
            PAPERCUSP_AGENT: 'omp',
            PAPERCUSP_LAUNCHED_BY: 'su-parent',
            PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
            PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '25',
            PAPERCUSP_TURN_PROVENANCE_DIR: join(root, 'provenance'),
            PI_CODING_AGENT_DIR: join(root, 'omp-agent'),
            TERM: 'xterm-256color',
          },
          ownerId,
          io,
          bridgeTty: true,
          kickoffFile: seed,
          sessionPort: { renderedHash: hash },
          onKickoffPersisted,
          nativePersistenceTimeoutMs: 5000,
          signalSource: signals,
          reapScopeResidue,
          onExit: () => undefined,
        });
        const deadline = Date.now() + 3000;
        while (!/GRAND:\d+/.test(captured()) && Date.now() < deadline) await sleep(25);
        const grandPid = Number(captured().match(/GRAND:(\d+)/)?.[1]);
        expect(grandPid).toBeGreaterThan(1);

        signals.emit('SIGTERM');
        // External kill must not wait for node-pty's asynchronous child exit
        // event: fleet:kill may SIGKILL this host during that gap.
        expect(reapScopeResidue).toHaveBeenCalledTimes(1);
        await done;
        expect(onKickoffPersisted).toHaveBeenCalledTimes(1);
        expect(onKickoffPersisted.mock.calls[0]?.[0]).toMatchObject({
          persisted: false,
          renderedHash: hash,
        });
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
        expect(signals.listenerCount('SIGHUP')).toBe(0);

        let alive = true;
        const reapDeadline = Date.now() + 2000;
        while (alive && Date.now() < reapDeadline) {
          try { process.kill(grandPid, 0); } catch { alive = false; }
          if (alive) await sleep(25);
        }
        expect(alive).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

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

  it(
    'EI-153: REFUSES a control envelope addressed to a DIFFERENT ownerId — never runs it — then still serves a correctly-addressed one',
    async () => {
      const ownerId = `su-itest-misdeliver-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),4000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 4243,
        io,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await sleep(400);
        expect(existsSync(sock)).toBe(true);

        // Addressed to a DIFFERENT agent — the host must refuse to run it, no
        // matter that the socket write itself succeeds (same-UID trust boundary
        // only guards WHO can connect, not WHOM the message is for).
        await envelopeInject(sock, { mode: 'raw', data: 'should-not-land\n', ownerId: 'su-someone-else' });
        await sleep(500);
        expect(captured()).not.toContain('ECHO:should-not-land');
        const events = readFileSync(eventLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const rejected = events.find(
          (e) => e.kind === 'control-payload-rejected' && e.reason === 'ownerId-mismatch',
        );
        expect(rejected).toMatchObject({ expected: ownerId, got: 'su-someone-else', mode: 'raw' });

        // The host itself is otherwise unharmed: a correctly-addressed (or
        // unaddressed, pre-EI-153-shaped) message still lands normally.
        await envelopeInject(sock, { mode: 'raw', data: 'should-land\n', ownerId });
        await sleep(500);
        expect(captured()).toContain('ECHO:should-land');
      } finally {
        // The child self-exits on its own 4s timeout — just wait for host resolution.
        await done.catch(() => undefined);
      }
    },
    20_000,
  );

  it(
    "WI-2141435: control-payload-unaddressed fires with envelope:true for a v1 envelope that " +
      'simply omits ownerId, and envelope:false for a genuinely non-envelope legacy payload — the ' +
      "detector the EI-153 guard's reject-only logging could not provide (its silence could not " +
      "distinguish 'nothing to catch' from 'structurally blind to this class'). DETECTOR ONLY: " +
      'control flow is unchanged, so this test only asserts the event log, not delivery.',
    async () => {
      const ownerId = `su-itest-unaddressed-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { io } = fakeIo();

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', 'setTimeout(()=>process.exit(0),4000);'],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        advSessionId: 424535,
        io,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await sleep(400);
        expect(existsSync(sock)).toBe(true);

        // Case A: a well-formed v1 envelope that simply OMITS ownerId (a pre-EI-153
        // sender) — decodeControl decodes it normally; only ownerId is unset.
        await envelopeInject(sock, { mode: 'raw', data: 'x' });
        await sleep(300);

        // Case B: a genuinely non-envelope payload (not JSON at all) — decodeControl's
        // legacy promotion to mode:'turn' with no ownerId whatsoever.
        await new Promise<void>((resolve) => {
          const c = net.connect(sock, () => {
            c.write('plain-legacy-text');
            c.end();
          });
          c.on('data', () => {});
          c.on('error', () => resolve());
          c.on('close', () => resolve());
        });
        await sleep(300);

        const events = readFileSync(eventLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const unaddressed = events.filter((e) => e.kind === 'control-payload-unaddressed');
        expect(unaddressed).toHaveLength(2);
        expect(unaddressed.find((e) => e.mode === 'raw')).toMatchObject({ reason: 'no-ownerId', envelope: true });
        expect(unaddressed.find((e) => e.mode === 'turn')).toMatchObject({ reason: 'no-ownerId', envelope: false });
      } finally {
        await done.catch(() => undefined);
      }
    },
    20_000,
  );
});

describe('RECYCLE / backend-aware RESET — kill + respawn the child in the same host (su-cold-auto-mode P-004b)', () => {
  it(
    'uses the Claude composer glyph to deliver a carry while the fresh TUI keeps repainting',
    async () => {
      const ownerId = `su-recycle-claude-ready-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n❯\\n');" +
        "const marker=process.argv[process.argv.length-1];" +
        "let repaint=null;if(marker==='RECYCLED'){repaint=setInterval(()=>process.stdout.write('.'),20);}" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}if(repaint){clearInterval(repaint);repaint=null;}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';
      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '2000',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintCarryRespawnArgs: (args: string[]) => ({ args: args.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        await sleep(600);
        expect(captured()).toContain('BOOT:');
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: 'CARRIED',
          systemPromptAddendum: 'deterministic carry',
          drillId: 'claude-ready',
          sessionClass: 'claude-su',
        });
        const deadline = Date.now() + 5_000;
        while (!captured().includes('ECHO:CARRIED') && Date.now() < deadline) await sleep(25);
        expect(captured()).toContain('ECHO:CARRIED');
        const events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(events.filter((event) => event.kind === 'busy-gate-expired' && event.mode === 'carry-respawn')).toEqual([]);
        expect(JSON.parse(readFileSync(meta, 'utf8')).carryDropCount ?? 0).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done;
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

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
          // Reproduce the live failure deterministically: the fake successor
          // emits BOOT output but never Codex's version-specific composer
          // footer. The bounded fallback must admit it via output quiescence.
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          TERM: 'xterm-256color',
          // Speed the post-respawn carry inject: the fresh child's boot output goes
          // quiet fast, so a short output-quiet window lets the carry land promptly.
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
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

      // A Codex RESET with a carry-note must take the same hard path as RECYCLE.
      // The host kills the child, fresh-spawns it in the SAME host (same
      // socket/meta/SID), and opens the fresh process on the carry.
      await controlInject(sock, 'reset', 'CARRIED');
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

  it(
    'force-kills a graceful-signal-resistant predecessor before spawning the successor',
    async () => {
      const ownerId = `su-recycle-predecessor-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>{});" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='QUIT')process.exit(0);}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS: '250',
          PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS: '500',
        },
        ownerId,
        advSessionId: 42,
        io,
        bridgeTty: false,
      });

      const bootDeadline = Date.now() + 5_000;
      while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
      expect(captured()).toContain('BOOT:');
      const firstBoot = Number(captured().match(/BOOT:(\d+)/)?.[1]);
      expect(Number.isInteger(firstBoot)).toBe(true);

      await controlInject(sock, 'recycle', '');
      const successorDeadline = Date.now() + 8_000;
      let boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      while (boots.length < 2 && Date.now() < successorDeadline) {
        await sleep(25);
        boots = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      }
      expect(boots).toHaveLength(2);
      expect(boots[1]).not.toBe(firstBoot);

      // The predecessor ignores the graceful signal. It must be dead before
      // this host can leave the recycle path with a second writer in flight.
      const predecessorGoneDeadline = Date.now() + 2_000;
      let predecessorAlive = true;
      while (predecessorAlive && Date.now() < predecessorGoneDeadline) {
        try {
          process.kill(firstBoot, 0);
        } catch {
          predecessorAlive = false;
          break;
        }
        await sleep(25);
      }
      expect(predecessorAlive).toBe(false);

      await rawInject(sock, 'QUIT\n');
      await done;
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

describe('carry-respawn TERMINAL FALLBACK — a successor that emits NOTHING still gets its turn (WI-38257)', () => {
  it(
    'delivers the carry to a zero-output successor instead of dropping it with attempts:0',
    async () => {
      const ownerId = `su-zerooutput-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();

      // The distinguishing detail, and the whole point of this test: this child
      // writes NOTHING on boot. No banner, no marker, not one byte. It is
      // otherwise perfectly healthy and echoes anything typed at it.
      //
      // That is the shape of the 2026-08-12 incident, whose ledger row read
      // `respawn-carry-dropped reason=no-startup-ready-marker attempts=0
      // outputSeen=false`. The startup-marker TIME fallback added in d351ee3084
      // cannot rescue this case: it is gated on childStartupFirstOutputAt > 0,
      // and a child that never emits leaves that at 0 forever. Before the
      // terminal fallback, the host skipped its delivery loop entirely and never
      // once tried to write — so a healthy successor sat at its prompt, silent,
      // while every wake was deferred and the agent was dead until a human typed.
      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          // A backend whose readiness marker this child will never emit, plus a
          // short fallback window — so the ONLY thing that can deliver the carry
          // is the terminal fallback itself.
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          // A zero-output child spins the startup-marker wait for the WHOLE
          // inject budget (there is no first-output timestamp for the 300ms
          // fallback above to measure from), and only then does the terminal
          // fallback get its one attempt. That is the intended shape — a
          // slow-booting child should still get the full grace — so shorten the
          // budget here rather than sleeping past the production default. This
          // also pins the recovery as BOUNDED: without a short budget the test
          // passes only by waiting longer, which would hide a regression that
          // made the wait unbounded again.
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '800',
          // A fleet-bound host recolors the visible terminal by writing OSC
          // probes to stdout at launch. This fixture asserts that the child
          // emits zero bytes, so keep the test independent of the caller's
          // fleet color environment.
          PAPERCUSP_FLEET_BG: '',
          PAPERCUSP_FLEET_FG: '',
          PAPERCUSP_FLEET_CURSOR: '',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(600);
      // Precondition, asserted rather than assumed: the child really is silent.
      // If it ever starts emitting, this test would still pass while no longer
      // testing the zero-output path at all — a vacuous guard.
      expect(captured()).toBe('');

      await controlInject(sock, 'recycle', 'CARRIED');
      await sleep(2500);

      // The continuation turn started with no human input. This is the item's
      // acceptance criterion stated as an assertion.
      expect(captured()).toContain('ECHO:CARRIED');

      await rawInject(sock, 'QUIT\n');
      await done;
    },
    25_000,
  );
});

describe('P-020 carry-respawn drill correlation', () => {
  it(
    'records the fresh native id, carry path, and first-prompt delivery in the durable host event log',
    async () => {
      const ownerId = `su-carry-drill-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';
      const nativeId = 'ddddabcd-1234-5678-9abc-def012345678';
      const carryPath = '/safe/carry-drill-d-1.md';
      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '200',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '100',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintCarryRespawnArgs: (args: string[]) => ({ args, nativeId, launchContextPath: carryPath }),
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        await sleep(600);
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: '⟦carry-drill:d-1⟧',
          systemPromptAddendum: 'deterministic carry',
          drillId: 'd-1',
          sessionClass: 'claude-su',
        });
        const deliveryDeadline = Date.now() + 5_000;
        while (Date.now() < deliveryDeadline) {
          const log = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          if (log.includes('"kind":"carry-drill-carry-delivered"')) break;
          await sleep(25);
        }
        expect(captured()).toContain('ECHO:⟦carry-drill:d-1⟧');
        const events = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-respawned',
          drillId: 'd-1',
          sessionClass: 'claude-su',
          nativeId,
          launchContextPath: carryPath,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'carry-drill-carry-delivered',
          drillId: 'd-1',
          sessionClass: 'claude-su',
          nativeId,
        }));
        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    25_000,
  );
});

describe('carry-respawn native turn-start proof (EI-21561923024113260)', () => {
  it(
    'retries one CR and one fresh epoch before terminally dropping an unverified native turn',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'psu-carry-turn-proof-'));
      const claudeConfig = join(root, 'claude');
      mkdirSync(join(claudeConfig, 'projects', '-tmp'), { recursive: true });
      const ownerId = `su-carry-proof-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const nativeId = '12345678-1234-4234-8234-123456789abc';
      const marker = '⟦turn-origin:self-compaction nonce:fedcba9876543210⟧';
      const { captured, io } = fakeIo();
      // Every write repaints the PTY, reproducing outputSeen:true, but this fake
      // backend never persists a native user turn. Generic output verification
      // therefore passes while the authoritative transcript proof must fail.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;process.stdout.write('PAINT\\n');if(b.includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),10000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          CLAUDE_CONFIG_DIR: claudeConfig,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '1',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '500',
        },
        ownerId,
        io,
        bridgeTty: false,
        nativePersistenceTimeoutMs: 200,
        mintCarryRespawnArgs: (args: string[]) => ({ args, nativeId, launchContextPath: '/tmp/carry.md' }),
        onExit: () => {},
      });

      try {
        const bootDeadline = Date.now() + 2_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await envelopeInject(sock, {
          mode: 'carry-respawn',
          data: `${marker}\nContinue where you left off`,
          systemPromptAddendum: 'deterministic carry',
        });

        const outcomeDeadline = Date.now() + 5_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < outcomeDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            if (events.some((event) => event.kind === 'respawn-carry-dropped')) break;
          }
          await sleep(20);
        }

        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-turn-start-retry',
          nativeId,
          reason: 'native-turn-marker-timeout',
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'turn-start-unverified',
          nativeId,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-fresh-epoch-retry',
          reason: 'turn-start-unverified',
          detail: 'native-turn-marker-timeout',
          attempt: 1,
          maxRetries: 1,
        }));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          nativeId,
          reason: 'turn-start-unverified',
          outputSeen: true,
          turnStartVerified: false,
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(3);

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe('carry-respawn STALENESS guard — a message held too long by the busy gate is dropped, never delivered (EI-18109211232286833)', () => {
  it(
    'a carry-respawn that ages past PAPERCUSP_PSU_PTY_CARRY_STALE_MS while the busy gate waits is DROPPED — no second boot, no delivery, drop event recorded',
    async () => {
      const ownerId = `su-carry-stale-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      // BOOT, then spin (busy) for ~2000ms before going quiet + echoing stdin —
      // a generous window (well past this environment's fork/pty-startup
      // latency) so the message, sent once BOOT is confirmed AND still while
      // spinning, ages well past the tiny CARRY_STALE_MS below during the
      // busy-gate's wait for it to settle.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'let n=0;const iv=setInterval(()=>{process.stdout.write(".");if(++n>100)clearInterval(iv);},20);' +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          // Keep this fixture hermetic when the suite runs inside a live psu
          // session. Ambient identity/configuration must not rewrite the
          // handoff contract this test is asserting.
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          PAPERCUSP_AGENT: 'codex',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '100',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '5000', // generous — the busy gate must NOT defer/drop here
          PAPERCUSP_PSU_PTY_CARRY_STALE_MS: '50', // tiny — the ~600ms spin easily ages past it
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      try {
        // Poll for BOOT rather than a fixed sleep — fork/pty-startup latency
        // varies by environment; the child's ~2000ms spin gives ample margin
        // to detect BOOT and still inject while it's genuinely busy.
        const bootDeadline = Date.now() + 3_000;
        while (Date.now() < bootDeadline && !captured().includes('BOOT:')) {
          await sleep(20);
        }
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);

        // Sent while the child is still busy spinning: receivedAtMs is stamped
        // NOW, then the (unconditional) busy gate waits out the remaining spin
        // + quiet(100ms) before this would otherwise deliver — comfortably
        // aging past the 50ms stale cap during that wait.
        await envelopeInject(sock, {
          mode: 'carry-respawn',
          ownerId,
          data: 'CARRIED',
          systemPromptAddendum: 'stale carry test',
        });

        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const log = existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '';
          if (log.includes('"kind":"respawn-carry-dropped"')) break;
          await sleep(25);
        }

        const events = readFileSync(eventLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          mode: 'carry-respawn',
          reason: 'carry-stale',
        }));
        // Never delivered — no second boot (no recycle happened) and the carry
        // text never reached the child's stdin.
        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);
        expect(captured()).not.toContain('ECHO:CARRIED');

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
        expect(exitCode).toBe(0);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
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

describe('RECYCLE respawn report ordering', () => {
  it(
    'waits for the async onRespawn report before publishing successor metadata and output wiring',
    async () => {
      const ownerId = `su-recycle-order-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "const marker=process.argv[process.argv.length-1];" +
        "process.stdout.write('BOOT:'+marker+'\\n');" +
        "if(marker==='RECYCLED')setInterval(()=>process.stdout.write('LIVE:'+marker+'\\n'),25);" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='QUIT')process.exit(0);}});" +
        'setTimeout(()=>process.exit(0),15000);';
      const freshNativeId = 'eeeeabcd-1234-5678-9abc-def012345678';
      // Keep the report promise separate from the start signal: the host must
      // reach the callback before this test releases it, otherwise an ordering
      // regression could pass by accident.
      let signalReportStarted!: () => void;
      const reportStartedSignal = new Promise<void>((resolve) => { signalReportStarted = resolve; });
      let releaseReport!: () => void;
      const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
      const respawns: string[] = [];
      const mintCalls: string[][] = [];
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_FLEET_BG: '',
          PAPERCUSP_FLEET_FG: '',
          PAPERCUSP_FLEET_CURSOR: '',
          TERM: 'xterm-256color',
        },
        ownerId,
        io,
        bridgeTty: false,
        mintRecycleArgs: (args: string[]) => {
          mintCalls.push(args);
          return { args: args.slice(0, -1).concat('RECYCLED'), nativeId: freshNativeId };
        },
        onRespawn: (nativeId: string) => {
          respawns.push(nativeId);
          signalReportStarted();
          return reportGate;
        },
        onExit: () => {},
      });

      try {
        await vi.waitFor(() => expect(captured()).toContain('BOOT:ORIGINAL'), { timeout: 2_000 });
        const predecessorPid = JSON.parse(readFileSync(meta, 'utf8')).ptyPid;

        await controlInject(sock, 'recycle', '');
        await reportStartedSignal;
        await sleep(100);

        // The fresh child has already been spawned, but no successor metadata or
        // output listener may be published until the async report resolves.
        expect(JSON.parse(readFileSync(meta, 'utf8')).ptyPid).toBe(predecessorPid);
        expect(captured()).not.toContain('LIVE:RECYCLED');
        expect(respawns).toEqual([freshNativeId]);
        expect(mintCalls).toHaveLength(1);

        releaseReport();
        await vi.waitFor(() => expect(captured()).toContain('LIVE:RECYCLED'), { timeout: 2_000 });
        expect(JSON.parse(readFileSync(meta, 'utf8')).ptyPid).not.toBe(predecessorPid);

        await rawInject(sock, 'QUIT\n');
        expect(await done).toBe(0);
      } finally {
        // If an assertion fails before the report is released, unblock the
        // host's bounded callback wait so cleanup cannot consume the whole test
        // timeout while a child is still alive.
        releaseReport();
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done;
      }
    },
    25_000,
  );
});

describe('ADOPTION — a stale host hands the session to a fresh launcher instead of respawning inside itself (WI-38292)', () => {
  // The bug: psu-launcher imports psu-pty-host ONCE and `recycleChild` only ever
  // replaces the CLI child, so a host fix committed after this process booted is
  // inert for the session's whole life. Increment 1 made that visible; this is
  // the leg that makes the session actually RUN the new code. The reporter's
  // stated acceptance is exactly this: "a host-version change is adopted before
  // the successor carry is delivered".
  const childCode =
    "process.stdout.write('BOOT:'+process.pid+'\\n');" +
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
    "if(line==='QUIT'){process.exit(0);}}});" +
    'setTimeout(()=>process.exit(0),15000);';

  it(
    'writes the successor\'s orders, releases the discovery key, and leaves by the re-exec door WITHOUT respawning a child',
    async () => {
      const ownerId = `su-adopt-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const handoff = handoffPathFor(ownerId);
      const { captured, io } = fakeIo();
      const carryFile = join(mkdtempSync(join(tmpdir(), 'wi38292-carry-')), 'carry.md');
      writeFileSync(carryFile, 'the carry document\n');

      const reexecs: Array<{ code: number; mode: string }> = [];
      const ended: number[] = [];

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          PAPERCUSP_AGENT: 'codex',
          TERM: 'xterm-256color',
          // The shim's advertisement. Without it the host must NOT exit — see the
          // control below, which is the safety-critical half of this pair. The
          // PPID is part of it: the promise is only ours if OUR parent made it.
          PAPERCUSP_PSU_REEXEC: '87',
          PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid),
        },
        ownerId,
        advSessionId: 42,
        io,
        bridgeTty: false,
        // The file on disk moved on after this process loaded it — the live
        // reproduction, injected rather than performed, because performing it
        // would mean rewriting the checkout mid-test.
        hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
        mintCarryRespawnArgs: (a: string[]) => ({
          args: a.slice(0, -1).concat('--append-system-prompt-file', carryFile),
          nativeId: 'aaaabbbb-1111-2222-3333-444455556666',
          launchContextPath: carryFile,
        }),
        onReexec: ({ code, mode }: { code: number; mode: string }) => { reexecs.push({ code, mode }); },
        onExit: (c: number) => { ended.push(c); },
      });

      await sleep(600);
      expect(captured()).toContain('BOOT:');
      const firstBoots = [...captured().matchAll(/BOOT:/g)].length;
      expect(firstBoots).toBe(1);

      await envelopeInject(sock, {
        mode: 'carry-respawn',
        data: 'CARRIED',
        systemPromptAddendum: 'deterministic carry',
      });

      const code = await done;

      // Left by the re-exec door, with the shim's advertised code…
      expect(reexecs).toEqual([{ code: 87, mode: 'carry-respawn' }]);
      expect(code).toBe(87);
      // …and NOT by the ordinary exit door: this session is continuing in a new
      // process, so reporting it ended would bury it in adv_sessions and leave the
      // successor climbing out of a grave.
      expect(ended).toEqual([]);
      // No second child was spawned inside this stale host — that is the whole
      // point. A respawn here would have run the OLD code again.
      expect([...captured().matchAll(/BOOT:/g)].length).toBe(1);

      // The successor's orders reached disk, carrying the argv this host had
      // already minted — the carry rides the file, not the dead process's memory.
      expect(existsSync(handoff)).toBe(true);
      const orders = JSON.parse(readFileSync(handoff, 'utf8'));
      expect(orders).toMatchObject({
        ownerId,
        mode: 'carry-respawn',
        fromPid: process.pid,
        launchContextPath: carryFile,
        nativeId: 'aaaabbbb-1111-2222-3333-444455556666',
        advSessionId: 42,
        codexHome: '/tmp/codex-home-for-handoff',
        // P-022: a carry successor must not keep Claude's native compactors.
        childEnv: {
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_ADV_SESSION_ID: '42',
          CODEX_HOME: '/tmp/codex-home-for-handoff',
          DISABLE_AUTO_COMPACT: '1',
          DISABLE_COMPACT: '1',
        },
      });
      expect(orders.args).toContain('--append-system-prompt-file');
      expect(orders.args).toContain(carryFile);

      // Released BEFORE the successor can assert them (host:2739 — a second host
      // on a live discovery key strands the first).
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);

      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
      expect(events).toContain('"kind":"host-code-adopting"');

      unlinkSync(handoff);
    },
    25_000,
  );

  it(
    'CONTROL: with no shim advertisement it respawns in place — a launcher nobody will re-run must never exit',
    async () => {
      // Same staleness, same wiring, one thing removed: the promise that something
      // will re-run us. Under an old shim / an operator-spawned headless member,
      // exiting would simply END the owner's session. This is the pair that makes
      // the test above evidence about the HANDSHAKE rather than about staleness.
      const ownerId = `su-adopt-noshim-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const { captured, io } = fakeIo();
      const env = { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' };
      delete env.PAPERCUSP_PSU_REEXEC;
      delete env.PAPERCUSP_PSU_REEXEC_PPID;

      const reexecs: number[] = [];
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'ORIGINAL'],
        cwd: '/tmp',
        env,
        ownerId,
        io,
        bridgeTty: false,
        hostCodeStalenessFn: () => ({ stale: true, loaded: 'a'.repeat(64), onDisk: 'b'.repeat(64) }),
        mintRecycleArgs: (a: string[]) => ({ args: a, nativeId: null }),
        onReexec: ({ code }: { code: number }) => { reexecs.push(code); },
        onExit: () => {},
      });

      await sleep(600);
      expect([...captured().matchAll(/BOOT:/g)].length).toBe(1);

      await controlInject(sock, 'recycle', '');
      await sleep(2500);

      // Respawned in place, exactly as before WI-38292 — a stale host, but a live
      // session — and the re-exec door was never opened.
      expect([...captured().matchAll(/BOOT:/g)].length).toBe(2);
      expect(reexecs).toEqual([]);
      // The staleness is still REPORTED, so the condition stays visible.
      const eventLog = readFileSync(eventLogPathForOwner(ownerId), 'utf8');
      expect(eventLog).toContain('"kind":"host-code-stale"');
      // WI-10001514: and the row now says WHY it did not adopt. Without that, this
      // no-shim headless host — which COULD have adopted safely and is a real gap —
      // is byte-identical to an interactive host refusing correctly, which is why
      // 7,021 of 9,087 measured stale detections were unattributable to either
      // cause. This case is the sharp one: onReexec IS wired and only the shim
      // advertisement is missing, so the reason must name the CODE, not the
      // callback. Asserting the exact discriminator keeps the two from collapsing
      // back into one label.
      const staleRow = eventLog
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((e) => e.kind === 'host-code-stale');
      expect(staleRow).toBeDefined();
      expect(staleRow.adoptable).toBe(false);
      expect(staleRow.willAdopt).toBe(false);
      expect(staleRow.notAdoptingReason).toBe('no-reexec-code');
      expect(staleRow.bridgeTty).toBe(false);
      expect(staleRow.hasReexecCallback).toBe(true);
      expect(existsSync(handoffPathFor(ownerId))).toBe(false);

      await rawInject(sock, 'QUIT\n');
      await done;
    },
    25_000,
  );
});

describe('RECYCLE re-renders the base persona instead of inheriting it (stale-prompt-render-in-live-sessions-2026-08-02 P-003)', () => {
  // THE RECURRENCE GUARD for the staleness bug. mintRecycleArgs used to copy every
  // non-resume flag through verbatim, so `--system-prompt-file <predecessor render>`
  // survived every respawn and a session's base persona stayed pinned to launch #1
  // forever. Measured 2026-08-02: 27 of 53 live claude sessions were running a render
  // up to 14 days old, i.e. every prompt fix of that fortnight reached half the fleet.
  //
  // This drives the REAL hostThroughPty against the REAL mintRecycleArgs, so it covers
  // BOTH halves of the seam that has to stay wired: the host must CALL the refresh and
  // hand its result to the mint, and the mint must SWAP the flag. A unit test on either
  // half alone would still pass if the other half were quietly removed — which is
  // exactly how this bug would come back.
  //
  // Proven to fail against pre-fix behaviour: pre-fix there was no refreshPersonaFile
  // option at all, so nothing ever swapped the flag and the first expectation below
  // ("boots on the REFRESHED render") fails. The second case pins the other direction —
  // with no refresh available the inherited path MUST be kept, because that fail-soft is
  // what stops an operator hiccup from costing a live session its respawn.
  // The child is a real SCRIPT FILE, not `node -e`: node parses `--`-prefixed tokens
  // that follow `-e` as its OWN options and dies with "bad option:
  // --system-prompt-file". After a script path everything is a script arg, which is
  // also how the real backend is invoked.
  const childScript = join(
    mkdtempSync(join(tmpdir(), 'psu-persona-guard-')),
    'child.js',
  );
  writeFileSync(
    childScript,
    "const i=process.argv.indexOf('--system-prompt-file');" +
      "process.stdout.write('BOOT:'+process.pid+' SPF:'+(i>=0?process.argv[i+1]:'NONE')+'\\n');" +
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',d=>{b+=d;let i2;while((i2=b.indexOf('\\n'))>=0){const line=b.slice(0,i2);b=b.slice(i2+1);" +
      "if(line==='QUIT'){process.exit(0);}}});" +
      'setTimeout(()=>process.exit(0),15000);',
  );

  /** The PRE-FIX mint, frozen as a fixture: rotate the session id but copy every other
   *  flag through verbatim, ignoring personaFile entirely. That bare copy-through IS the
   *  bug (psu-launcher.mjs `out.push(a)`), and driving the guard with it is what proves
   *  the guard can actually detect what it was written for. */
  const preFixMint = (a: string[]) => ({ args: [...a, '--session-id', 'pre-fix'], nativeId: 'pre-fix' });

  /** `refreshed` = what the operator's persona-refresh hands back: a path, or null
   *  when the refresh failed / was unavailable. `mint` defaults to the REAL one. */
  async function driveRespawn(refreshed: string | null, mint?: (a: string[]) => unknown) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — pure JS script, no .d.ts
    const { mintRecycleArgs } = await import('../scripts/psu-launcher.mjs');
    const ownerId = `su-persona-refresh-itest-${process.pid}-${Math.floor(performance.now())}`;
    const sock = socketPathFor(ownerId);
    const stale = `/tmp/launch-context/session-STALE-${process.pid}.md`;
    const refreshPersonaFile = async () => ({ promptFile: refreshed });
    const { captured, io } = fakeIo();

    let exitCode: number | null = null;
    const done = hostThroughPty({
      command: execPath,
      args: [childScript, '--system-prompt-file', stale],
      cwd: '/tmp',
      // PAPERCUSP_AGENT=claude so the REAL mint synthesizes a --session-id for this
      // resume-shaped argv instead of no-op'ing (the 2026-07-18 mint gap).
      env: { ...process.env, PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: 'claude', TERM: 'xterm-256color' },
      ownerId,
      io,
      bridgeTty: false,
      mintRecycleArgs: mint ?? mintRecycleArgs,
      refreshPersonaFile,
      onExit: (c: number) => { exitCode = c; },
    });

    await sleep(600);
    // First boot always runs the launch argv verbatim — the inherited render.
    expect(captured()).toContain(`SPF:${stale}`);

    await controlInject(sock, 'recycle', '');
    await sleep(2500); // kill + respawn + boot

    const spfs = [...captured().matchAll(/SPF:(\S+)/g)].map((m) => m[1]);
    await rawInject(sock, 'QUIT\n');
    await done;
    expect(exitCode).toBe(0);
    return { spfs, stale };
  }

  it(
    'boots the successor on the REFRESHED render, not the predecessor\'s',
    async () => {
      const fresh = `/tmp/launch-context/session-refresh-FRESH-${process.pid}.md`;
      const { spfs, stale } = await driveRespawn(fresh);
      expect(spfs).toHaveLength(2);
      expect(spfs[0]).toBe(stale);
      // The whole point: the successor must NOT be running the file its predecessor
      // ran. This is the assertion that goes red if the seam is ever unwired.
      expect(spfs[1]).toBe(fresh);
      expect(spfs[1]).not.toBe(stale);
    },
    30_000,
  );

  it(
    'KEEPS the inherited render when the refresh yields nothing (fail-soft, = pre-fix behaviour)',
    async () => {
      // A refresh that failed or was unavailable must never cost the session its
      // respawn — a stale prompt beats a dead session. This also pins that the swap is
      // CONDITIONAL, so a future change cannot start rewriting argv unconditionally.
      const { spfs, stale } = await driveRespawn(null);
      expect(spfs).toHaveLength(2);
      expect(spfs.every((s) => s === stale)).toBe(true);
    },
    30_000,
  );

  it(
    'PROOF the guard discriminates: under the PRE-FIX mint the successor inherits the stale render even though a refresh was available',
    async () => {
      // A guard that cannot detect what it was written for is theatre (P-003). This
      // reproduces the original bug on demand: a refresh IS supplied, yet the copy-
      // through mint carries `--system-prompt-file <stale>` into the successor anyway.
      // The first test in this block asserts the opposite outcome from the same input,
      // so if the fix were ever unwired that test necessarily goes red.
      const fresh = `/tmp/launch-context/session-refresh-FRESH-${process.pid}.md`;
      const { spfs, stale } = await driveRespawn(fresh, preFixMint);
      expect(spfs).toHaveLength(2);
      expect(spfs[1]).toBe(stale); // the bug, reproduced
      expect(spfs[1]).not.toBe(fresh);
    },
    30_000,
  );
});

describe('RECYCLE carry-inject is retried across a budget, then dropped LOUDLY (WI-1941)', () => {
  it(
    'RETRIES past a fresh child that stays busy beyond one busy-cap, injecting the carry once it settles',
    async () => {
      const ownerId = `su-recycle-retry-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // On EACH boot the child prints BOOT:<pid>, then SPINS (a dot every 20ms for
      // ~700ms) so its output stays "busy" past the busy-cap, THEN goes quiet and
      // echoes stdin. A single-shot waitAtPrompt (cap 300 < 700ms spin) would DROP
      // the carry — so 'ECHO:CARRIED' landing proves the retry loop worked.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'let n=0;const iv=setInterval(()=>{process.stdout.write(".");if(++n>35)clearInterval(iv);},20);' +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '300',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '300', // shorter than the ~700ms spin → attempts defer
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '8000', // ample budget → retry, don't drop
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '50',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(1200); // let the initial child boot + finish its spin
      expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);

      await controlInject(sock, 'recycle', 'CARRIED');
      // kill + respawn + boot + ~700ms spin + retries across the 300ms cap until it
      // settles + quiet(150) + submit CR — comfortably inside this window.
      await sleep(4000);

      const bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      expect(bootsAfter).toHaveLength(2); // genuinely respawned
      // The carry landed via RETRY (the fresh child was busy past the first cap).
      expect(captured()).toContain('ECHO:CARRIED');
      // …and nothing was recorded as dropped.
      const metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      expect(metaAfter.carryDropCount ?? 0).toBe(0);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    30_000,
  );

  it(
    'retries one fresh epoch, then DROPS LOUDLY when the child never settles',
    async () => {
      const ownerId = `su-recycle-drop-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      // WI-1818 (clean-boundary-only kill): the pre-recycle busy gate is now
      // unconditional (applies regardless of bridgeTty), so the ORIGINAL child
      // must genuinely settle before the recycle can fire at all — else the kill
      // itself would be (correctly) refused and this test would never exercise
      // the POST-recycle carry-drop path it's actually about. So the ORIGINAL
      // boot bursts briefly then goes quiet; the RESPAWNED boot (marked via
      // mintRecycleArgs, WI-1980-style) SPINS FOREVER — every post-recycle
      // waitAtPrompt attempt across the budget defers and the carry is
      // ultimately DROPPED after the bounded fresh-epoch retry. The dropped
      // iteration must be OBSERVABLE (WI-1941: never traceless) — asserted via
      // the durable meta counter. QUIT still
      // lands (raw inject bypasses the gate; the stdin handler fires between
      // the non-blocking spin ticks).
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "const marker=process.argv[process.argv.length-1];" +
        "if(marker==='RECYCLED'){setInterval(()=>process.stdout.write('.'),20);}" +
        "else{let n=0;const iv=setInterval(()=>{process.stdout.write('.');if(++n>8)clearInterval(iv);},20);}" +
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode, 'INITIAL'],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '150',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '200',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '700', // small → exhaust fast, then drop
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '40',
        },
        ownerId,
        io,
        bridgeTty: false,
        // Rewrite the respawn argv so ONLY the post-recycle boot spins forever —
        // the ORIGINAL boot must settle for the pre-kill busy gate to let the
        // recycle fire at all (see the comment above).
        mintRecycleArgs: (a: string[]) => ({ args: a.slice(0, -1).concat('RECYCLED'), nativeId: null }),
        onExit: (c: number) => { exitCode = c; },
      });

      await sleep(800);
      expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(1);

      await controlInject(sock, 'recycle', 'CARRIED');
      // Under the full integration suite, CPU scheduling can delay the fresh
      // child beyond the old one-shot 2500ms sleep even though the host is
      // progressing normally. Poll for the observable respawn marker within a
      // bounded budget so this test measures the carry-drop contract rather
      // than a scheduler-specific wall-clock slice.
      const bootsDeadline = Date.now() + 8_000;
      let bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
      let metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      while (
        (bootsAfter.length < 2 || metaAfter.carryDropCount !== 1) &&
        Date.now() < bootsDeadline
      ) {
        await sleep(50);
        bootsAfter = [...captured().matchAll(/BOOT:(\d+)/g)].map((m) => Number(m[1]));
        metaAfter = JSON.parse(readFileSync(meta, 'utf8'));
      }
      expect(bootsAfter).toHaveLength(3); // original + one bounded fresh-epoch retry
      // The carry was NEVER injected (the fresh child never reached its prompt)…
      expect(captured()).not.toContain('ECHO:CARRIED');
      // …and the drop is DURABLY OBSERVABLE, not silent (WI-1941 core guarantee).
      expect(metaAfter.carryDropCount).toBe(1);
      expect(typeof metaAfter.lastCarryDropAt).toBe('number');
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8')
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'respawn-carry-fresh-epoch-retry',
        reason: 'no-startup-ready-marker-last-resort-failed',
        attempt: 1,
        maxRetries: 1,
      }));

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    30_000,
  );

  it(
    'books a verifier-exhausted RECYCLE carry as dropped, cleans up fatally, and never emits delivered (WI-42318)',
    async () => {
      const ownerId = `su-recycle-submit-drop-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        "if(process.stdin.isTTY)process.stdin.setRawMode(true);" +
        "process.stdin.setEncoding('utf8');" +
        "process.stdin.on('data',d=>{if(String(d).includes('QUIT'))process.exit(0);});" +
        'setTimeout(()=>process.exit(0),15000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          PAPERCUSP_AGENT: 'claude',
          TERM: 'xterm-256color',
          PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '50',
          PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
          PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '50',
          PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '20',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '4',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR: '2',
          PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '1',
          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '1500',
        },
        ownerId,
        io,
        bridgeTty: false,
        onExit: (code: number) => { exitCode = code; },
      });

      try {
        const bootDeadline = Date.now() + 3_000;
        while (!captured().includes('BOOT:') && Date.now() < bootDeadline) await sleep(20);
        expect(captured()).toContain('BOOT:');

        await controlInject(sock, 'recycle', 'CARRIED');
        const outcomeDeadline = Date.now() + 5_000;
        let events: Array<Record<string, unknown>> = [];
        while (Date.now() < outcomeDeadline) {
          if (existsSync(eventLog)) {
            events = readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            if (events.some((event) => event.kind === 'respawn-carry-dropped')) break;
          }
          await sleep(20);
        }

        expect([...captured().matchAll(/BOOT:(\d+)/g)]).toHaveLength(2);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'respawn-carry-dropped',
          reason: 'submit-verification-exhausted',
          attempts: 1,
          outputSeen: true,
        }));
        expect(events.some((event) => event.kind === 'respawn-carry-delivered')).toBe(false);
        expect(await done).toBe(1);
        expect(exitCode).toBe(1);
        expect(existsSync(sock)).toBe(false);
        expect(existsSync(meta)).toBe(false);
      } finally {
        if (existsSync(sock)) await rawInject(sock, 'QUIT\n');
        await done.catch(() => undefined);
        if (existsSync(eventLog)) unlinkSync(eventLog);
      }
    },
    20_000,
  );
});

describe('final interactive terminal handoff (WI-42458)', () => {
  it(
    'disables mouse reporting after the child exits before returning the terminal to its shell',
    async () => {
      let captured = '';
      const rawModes: boolean[] = [];
      const stdout = {
        columns: 100,
        rows: 40,
        write: (d: Buffer | string) => {
          captured += d.toString();
        },
        on() {},
        off() {},
      };
      const stdin = Object.assign(new EventEmitter(), {
        isTTY: true,
        resume() {},
        pause() {},
        setRawMode(enabled: boolean) {
          rawModes.push(enabled);
        },
      });
      const ownerId = `su-final-terminal-handoff-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const childCode =
        "process.stdout.write('\\x1b[?1003h\\x1b[?1006h');" +
        'setTimeout(()=>process.exit(0),50);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        onExit: () => {},
      });

      expect(await done).toBe(0);
      const mouseEnableAt = captured.indexOf('\x1b[?1003h');
      const mouseDisableAt = captured.lastIndexOf('\x1b[?1003l');
      expect(mouseEnableAt).toBeGreaterThanOrEqual(0);
      expect(mouseDisableAt).toBeGreaterThan(mouseEnableAt);
      for (const mode of ['1000', '1002', '1003', '1006']) {
        expect(captured).toContain(`\x1b[?${mode}l`);
      }
      expect(captured).toContain('\x1b[?2004l');
      expect(captured).not.toContain('session restarted');
      expect(rawModes).toEqual([true, false]);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    10_000,
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
      expect(findLiveHost(ownerId, undefined, ID_OK)).not.toBeNull();

      // Start a 20s foreground job. If the interrupt FAILS, the typed `exit` queues
      // behind it and this test blows its 15s timeout — so a clean finish is itself
      // evidence the sleep was cut short.
      type('sleep 20\n');
      await sleep(600);

      const ok = await interruptViaPty(ownerId, 'sigint', ID_OK);
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

describe('orphan / vanished-terminal teardown (WI-3141)', () => {
  it(
    'tears down (kills the child, cleans up socket+meta) when the bridged terminal closes — stdin EOF/close',
    async () => {
      // A managed-pty host must not outlive the interactive terminal it bridges.
      // Simulate the terminal vanishing: a real interactive bridge (bridgeTty) whose
      // stdin emits 'close'. The host must kill its (still-alive, 20s-safety-net)
      // child and clean up — instead of lingering as a forwarding orphan (the
      // "random characters appear without typing" report).
      const ownerId = `su-orphan-eof-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      let captured = '';
      const stdout = { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {}, setRawMode() {} });

      // Long-lived child (20s net) that would keep the host alive forever if the
      // terminal-close teardown didn't fire.
      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'process.stdin.on(\'data\',()=>{});' +
        'setTimeout(()=>process.exit(0),20000);';

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        onExit: (c: number) => { exitCode = c; },
      });

      // Poll for BOOT rather than a fixed sleep — fork/pty-startup latency
      // varies under load; a fixed 500ms sleep flakes on a busy box (the
      // 2026-07-26 red-test watchdog catch, EI-18679045634730262: this file's
      // other tests already use this poll instead of a fixed sleep for the
      // same reason).
      const bootDeadline = Date.now() + 5_000;
      while (Date.now() < bootDeadline && !captured.includes('BOOT:')) {
        await sleep(20);
      }
      expect(existsSync(sock)).toBe(true);
      expect(captured).toContain('BOOT:');

      // The terminal closes: stdin hits EOF/close. The host must tear down promptly
      // (well inside this test's budget — not the child's 20s safety net).
      (stdin as EventEmitter).emit('close');

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    'tears down when the launching parent dies (reparent-to-init) even if the pts stays alive',
    async () => {
      // The exact 2026-07-05 orphan: psu's launching shell exits (ppid→init) while
      // the /dev/pts stays alive (a fresh shell took it over), so stdin never hits
      // EOF. The parent-death watchdog must catch it. parentPidFn is injected to
      // fake the reparent without a real fork; a short poll keeps the test fast.
      const ownerId = `su-orphan-ppid-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      let captured = '';
      const stdout = { columns: 80, rows: 24, write: (d: Buffer | string) => { captured += d.toString(); }, on() {}, off() {} };
      const stdin = Object.assign(new EventEmitter(), { isTTY: true, resume() {}, pause() {}, setRawMode() {} });

      const childCode =
        "process.stdout.write('BOOT:'+process.pid+'\\n');" +
        'process.stdin.on(\'data\',()=>{});' +
        'setTimeout(()=>process.exit(0),20000);';

      // Starts NON-init (a live shell); flip to init to simulate the shell exiting.
      let fakeParent = 424242;

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color', PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS: '100' },
        ownerId,
        io: { stdin, stdout },
        bridgeTty: true,
        parentPidFn: () => fakeParent,
        onExit: (c: number) => { exitCode = c; },
      });

      // Poll for BOOT rather than a fixed sleep — fork/pty-startup latency
      // varies under load; a fixed 500ms sleep flakes on a busy box (the
      // 2026-07-26 red-test watchdog catch, EI-18679045634730262: this file's
      // other tests already use this poll instead of a fixed sleep for the
      // same reason).
      const bootDeadline = Date.now() + 5_000;
      while (Date.now() < bootDeadline && !captured.includes('BOOT:')) {
        await sleep(20);
      }
      expect(existsSync(sock)).toBe(true);
      expect(captured).toContain('BOOT:');

      // The launching shell exits → we get reparented to init. The watchdog's next
      // poll (≤100ms) must observe ppid===1 and tear the orphaned host down.
      fakeParent = 1;

      const code = await done;
      expect(code).toBe(0);
      expect(exitCode).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );
});

describe('WI-3455 — discovery key ownership + self-heal (the su-a8f52 stranding class)', () => {
  it(
    'self-heals: recreates a deleted json + re-binds a deleted sock while the host is live',
    async () => {
      const ownerId = `su-selfheal-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { captured, io } = fakeIo();

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}process.stdout.write('ECHO:'+line+'\\n');}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        activityPersistMs: 150,
        onExit: () => {},
      });

      await sleep(400);
      expect(existsSync(sock)).toBe(true);
      expect(existsSync(meta)).toBe(true);

      // Simulate the trample: a duplicate host / janitor race deletes BOTH.
      unlinkSync(meta);
      unlinkSync(sock);
      expect(existsSync(meta)).toBe(false);
      expect(existsSync(sock)).toBe(false);

      // Within a few ticks the live host re-asserts its key…
      await sleep(800);
      expect(existsSync(meta)).toBe(true);
      expect(existsSync(sock)).toBe(true);
      const healed = JSON.parse(readFileSync(meta, 'utf8'));
      expect(healed.ownerId).toBe(ownerId);
      expect(healed.pid).toBe(process.pid);

      // …and the re-bound socket actually accepts injection again.
      await rawInject(sock, 'post-heal\n');
      await sleep(500);
      expect(captured()).toContain('ECHO:post-heal');

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    20_000,
  );

  it(
    "exit cleanup leaves a SUCCESSOR's registration alone (no unlink of a key that is no longer ours)",
    async () => {
      const ownerId = `su-successor-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      // Default (15s) persist tick: no self-heal fires within this short test,
      // so the simulated successor registration below stays in place.
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        onExit: () => {},
      });

      await sleep(400);
      const mine = JSON.parse(readFileSync(meta, 'utf8'));
      expect(mine.pid).toBe(process.pid);

      // A successor host took over the key: the json now records ITS pid.
      writeFileSync(meta, JSON.stringify({ ...mine, pid: 999_999_999 }));

      // Our host exits → pre-WI-3455 this unlinked json+sock unconditionally,
      // stranding the successor. Now it must leave the key untouched.
      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(existsSync(meta)).toBe(true);
      expect(existsSync(sock)).toBe(true);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(999_999_999);

      // hygiene
      unlinkSync(meta);
      unlinkSync(sock);
    },
    20_000,
  );

  it(
    'stands down while a LIVE psu-marked process owns the key, then reclaims it after that process dies',
    async () => {
      const ownerId = `su-standdown-itest-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      // A decoy whose cmdline carries the psu marker (argv is part of
      // /proc/<pid>/cmdline), standing in for a genuinely live duplicate host.
      const decoy = spawn(execPath, ['-e', 'setTimeout(()=>{},10000)', 'psu-launcher-decoy'], {
        stdio: 'ignore',
      });
      await sleep(200);

      const childCode =
        "process.stdin.setEncoding('utf8');let b='';" +
        "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);" +
        "if(line==='QUIT'){process.exit(0);}}});" +
        'setTimeout(()=>process.exit(0),15000);';

      const done = hostThroughPty({
        command: execPath,
        args: ['-e', childCode],
        cwd: '/tmp',
        env: { ...process.env, PAPERCUSP_SID: ownerId, TERM: 'xterm-256color' },
        ownerId,
        io,
        bridgeTty: false,
        activityPersistMs: 150,
        onExit: () => {},
      });

      await sleep(400);
      const mine = JSON.parse(readFileSync(meta, 'utf8'));

      // The live decoy takes over the key → our host must STAND DOWN (no
      // re-assert flap war), even across several ticks.
      writeFileSync(meta, JSON.stringify({ ...mine, pid: decoy.pid }));
      await sleep(700);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(decoy.pid);

      // The decoy dies → the surviving host RECLAIMS the abandoned key.
      decoy.kill('SIGKILL');
      await sleep(900);
      expect(JSON.parse(readFileSync(meta, 'utf8')).pid).toBe(process.pid);

      await rawInject(sock, 'QUIT\n');
      const code = await done;
      expect(code).toBe(0);
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    25_000,
  );
});

/**
 * WI-6638 — SHUTDOWN: a finished agent session closes its own terminal window.
 *
 * psu runs as `exec <psu …>` inside `gnome-terminal --wait`, so the host exiting IS
 * the tab closing. These are the end-to-end halves that unit tests cannot reach: the
 * accepted path must actually TEAR THE HOST DOWN, and — the assertion that matters —
 * the refused path must leave a human's session demonstrably ALIVE.
 *
 * Why this is not a reaper: measured 2026-08-03, `findIdleLiveSessions()` returns 0
 * for this whole cohort (every psu session classifies driveMode:'responsive' and is
 * excluded by the queen-fleet-authority-boundary ruling P-001/D-001), and behind that
 * `terminalWindowAlive()` reads 55 of 55 stale scopes as ALIVE — correctly, because
 * they are real shells under the live terminal app. Both protections stand untouched.
 */
describe('SHUTDOWN — a finished agent session exits and closes its own window (WI-6638)', () => {
  /** Like envelopeInject, but returns the host's JSON ack line (the verdict). */
  function injectForAck(
    sock: string,
    envelope: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let acked: Record<string, unknown> | null = null;
      const c = net.connect(sock, () => {
        c.write(JSON.stringify({ v: 1, ...envelope }));
        c.end();
      });
      // Boundary-safe accumulation: a multi-byte character split across two
      // 'data' events must not decode to replacement chars (WI-6728 guard).
      // Attached before our own listener, so `collected.text()` below already
      // includes the chunk that triggered this callback.
      const collected = createTextCollector(c);
      c.on('data', () => {
        const buf = collected.text();
        const nl = buf.indexOf('\n');
        if (nl === -1 || acked) return;
        try {
          acked = JSON.parse(buf.slice(0, nl));
        } catch {
          /* malformed — the close below still resolves */
        }
      });
      c.on('error', () => resolve(acked));
      c.on('close', () => resolve(acked));
    });
  }

  /** A child that would outlive the test unless something actually kills it. */
  const LONG_LIVED_CHILD =
    "process.stdin.setEncoding('utf8');let b='';" +
    "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
    'setTimeout(()=>process.exit(0),60000);';

  it(
    'ACCEPTS an agent-launched, never-typed-into session: kills the child and tears the host down',
    async () => {
      const ownerId = `su-itest-shutdown-ok-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const meta = metaPathFor(ownerId);
      const { io } = fakeIo();

      let exitCode: number | null = null;
      const done = hostThroughPty({
        command: execPath,
        args: ['-e', LONG_LIVED_CHILD],
        cwd: '/tmp',
        env: {
          ...process.env,
          PAPERCUSP_SID: ownerId,
          TERM: 'xterm-256color',
          // The structural discriminator: injectLaunchedByArg stamps this onto every
          // tool-driven psu launch; an owner-typed `psu` never carries one.
          PAPERCUSP_LAUNCHED_BY: 'su-the-launching-agent',
        },
        ownerId,
        advSessionId: 6638,
        io,
        bridgeTty: false,
        onExit: (c: number) => {
          exitCode = c;
        },
      });

      await sleep(500);
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      // Advertised so a would-be requester can see the verdict before sending.
      expect(m.caps).toContain('shutdown');
      expect(m.launchedBy).toBe('su-the-launching-agent');

      const startedAt = Date.now();
      const ack = await injectForAck(sock, {
        mode: 'shutdown',
        data: 'fleet wound down',
        ownerId,
      });
      // The ACK must arrive BEFORE the teardown races the socket away — otherwise a
      // successful shutdown reads to the caller as a transport miss and gets retried.
      expect(ack).toMatchObject({ ok: true, reason: 'shutdown-accepted' });

      const code = await done;
      // The child's own timeout is 60s: finishing at all proves the shutdown killed it.
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(typeof code).toBe('number');
      expect(exitCode).not.toBeNull();
      // The window is gone: same cleanup path as any other child exit.
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(meta)).toBe(false);
    },
    40_000,
  );

  it(
    'REFUSES a session with no PAPERCUSP_LAUNCHED_BY and leaves it ALIVE — a hand-started window is the owner\'s',
    async () => {
      const ownerId = `su-itest-shutdown-refuse-${process.pid}-${Math.floor(performance.now())}`;
      const sock = socketPathFor(ownerId);
      const eventLog = eventLogPathForOwner(ownerId);
      const { captured, io } = fakeIo();

      // A hand-started psu carries no launcher provenance. Delete rather than blank
      // it, so a runner that happens to export one cannot mask the refusal.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PAPERCUSP_SID: ownerId,
        TERM: 'xterm-256color',
      };
      delete env.PAPERCUSP_LAUNCHED_BY;
      // A hand-started host is not bound to the fleet that runs this test process.
      // Clear inherited provenance so the headless-fleet ownership fallback cannot
      // classify this fixture as agent-owned.
      delete env.PAPERCUSP_FLEET_SLUG;

      const done = hostThroughPty({
        command: execPath,
        args: [
          '-e',
          "process.stdin.setEncoding('utf8');let b='';" +
            "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);process.stdout.write('ECHO:'+line+'\\n');}});" +
            'setTimeout(()=>process.exit(0),8000);',
        ],
        cwd: '/tmp',
        env,
        ownerId,
        advSessionId: 6639,
        io,
        bridgeTty: false,
        onExit: () => undefined,
      });

      try {
        await sleep(500);
        expect(existsSync(sock)).toBe(true);

        const ack = await injectForAck(sock, { mode: 'shutdown', data: 'go away', ownerId });
        expect(ack).toMatchObject({
          ok: false,
          reason: 'shutdown-refused:not-agent-launched',
        });

        // THE ASSERTION THIS TEST EXISTS FOR: the session is untouched. Wait past the
        // shutdown's own ack-delay + grace window, then prove the child still serves.
        await sleep(1200);
        expect(existsSync(sock)).toBe(true);
        await rawInject(sock, 'still-here\n');
        await sleep(500);
        expect(captured()).toContain('ECHO:still-here');

        // The refusal is recorded, so a puzzled operator can see WHY nothing closed.
        const events = readFileSync(eventLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        expect(events.find((e) => e.kind === 'shutdown-refused')).toMatchObject({
          reason: 'not-agent-launched',
        });
        expect(events.find((e) => e.kind === 'shutdown-accepted')).toBeUndefined();
      } finally {
        await done.catch(() => undefined);
      }
    },
    40_000,
  );
});
