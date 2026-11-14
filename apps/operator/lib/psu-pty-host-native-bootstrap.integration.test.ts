// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, eventLogPathForOwner, KICKOFF_PROOF_PATH_ENV, KICKOFF_PROOF_TOKEN_ENV } from '../scripts/psu-pty-host.mjs';
import { scanTextForSecrets } from '../../../packages/operator-core/lib/sync/pot-git/secrets-guard';

const workspaceFailure = 'Error: account/read failed during TUI bootstrap: account/read failed: ' +
  'workspace routing discovery timed out (code -32603)';
const mcpFailure = 'Error: Failed to start a fresh session through the app server: ' +
  'thread/start failed during TUI bootstrap: thread/start failed: error creating thread: ' +
  'Fatal error: Failed to initialize session: required MCP servers failed to initialize: ' +
  'papercusp-su: timed out handshaking with MCP server after 30s (code -32603)';

it.each([
  { failure: workspaceFailure, stage: 'account/read', reason: 'workspace-routing-discovery-timeout' },
  { failure: mcpFailure, stage: 'thread/start', reason: 'required-mcp-handshake-timeout' },
].flatMap(failure => ['codex', 'claude'].map(agent => ({ ...failure, agent }))))(
  'records a split pre-frame $stage failure only for Codex: $agent', async ({ agent, failure, stage, reason }) => {
  const ownerId = `test-bootstrap-${agent}-${process.pid}-${Date.now()}`;
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const childCode = [
    `const failure=${JSON.stringify(failure)};`,
    "process.stdout.write('unrelated fixture secret=do-not-persist\\n\\x1b[?25h');",
    "setTimeout(()=>process.stdout.write(failure.slice(0,70)),30);",
    "setTimeout(()=>process.stdout.write(failure.slice(70)+'\\r\\n'),80);",
    "setTimeout(()=>process.stdout.write(failure+'\\r\\n'),130);",
    'setTimeout(()=>process.exit(1),200);',
  ].join('');
  await hostThroughPty({
    command: process.execPath, args: ['-e', childCode], cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: agent, PAPERCUSP_SID: ownerId }),
    io: { stdin, stdout }, bridgeTty: false, onExit: () => {},
  });
  expect(output).toContain(failure);
  const log = eventLogPathForOwner(ownerId);
  const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const failures = events.filter(row => row.kind === 'backend-bootstrap-failed');
  expect(failures).toHaveLength(agent === 'codex' ? 1 : 0);
  if (agent === 'codex') {
    expect(failures[0]).toMatchObject({ agent: 'codex', stage,
      reason, gatewayRequested: false, accountPinPresent: false });
    expect(failures[0].msAfterFirstOutput).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(failures)).not.toContain('do-not-persist');
    expect(failures[0]).not.toHaveProperty('output');
  }
}, 15_000);

it.each([
  { exitCode: 0, nativeStarted: false, expectedFailure: false },
  { exitCode: 1, nativeStarted: false, expectedFailure: true },
  { exitCode: 1, nativeStarted: true, expectedFailure: false },
])('classifies post-frame MCP failure only on failed native startup: exit=$exitCode started=$nativeStarted', async ({ exitCode, nativeStarted, expectedFailure }) => {
  const ownerId = `test-bootstrap-after-frame-${process.pid}-${Date.now()}`;
  const nativeHome = mkdtempSync(join(tmpdir(), 'bootstrap-post-frame-'));
  const nativeId = randomUUID();
  const sessionsDir = join(nativeHome, 'sessions');
  mkdirSync(sessionsDir);
  const transcriptPath = join(sessionsDir, `rollout-${nativeId}.jsonl`);
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30, write() { return true; } };
  const frame = '\x1b[6n\x1b[1;1H│ >_ OpenAI Codex (v0.159.3) │\n' +
    '› Ask Codex to do anything\nReady · GPT-6.1-Sol default · Context 100% left\n';
  const childCode = [
    nativeStarted ? `require('node:fs').writeFileSync(${JSON.stringify(transcriptPath)},JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:'fixture-turn'}})+'\\n');` : '',
    `process.stdout.write(${JSON.stringify(frame)});`,
    `setTimeout(()=>process.stdout.write(${JSON.stringify(mcpFailure)}+'\\n'),80);`,
    `setTimeout(()=>process.exit(${exitCode}),150);`,
  ].join('');
  try {
    await hostThroughPty({
      command: process.execPath, args: ['-e', childCode], cwd: process.cwd(), ownerId,
      env: hermeticEnv({ PAPERCUSP_AGENT: 'codex', PAPERCUSP_SID: ownerId, CODEX_HOME: nativeHome }),
      resolveRespawnNativeId: () => nativeId,
      io: { stdin, stdout }, bridgeTty: false, onExit: () => {},
    });
    const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(row => row.kind === 'backend-session-frame-observed')).toBe(true);
    expect(events.filter(row => row.kind === 'backend-bootstrap-failed')).toHaveLength(expectedFailure ? 1 : 0);
  } finally {
    rmSync(nativeHome, { recursive: true, force: true });
  }
});

it.each([
  { withOutput: false, exitCode: 1, signal: null },
  { withOutput: true, exitCode: 1, signal: null },
  { withOutput: false, exitCode: 0, signal: 'SIGTERM' },
])('retains a native pre-turn exit witness with diagnostic output=$withOutput signal=$signal', async ({ withOutput, exitCode, signal }) => {
  const ownerId = `test-native-exit-${withOutput}-${signal}-${process.pid}-${Date.now()}`;
  const outputMarker = 'sample-sensitive-output-must-stay-out-of-events';
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const childCode = signal
    ? `process.kill(process.pid, ${JSON.stringify(signal)});`
    : withOutput
      ? `process.stderr.write(${JSON.stringify(outputMarker + '\n')}, () => process.exit(1));`
      : 'process.exit(1);';
  const proofDir = mkdtempSync(join(tmpdir(), 'native-exit-proof-'));
  const proofPath = join(proofDir, 'receipt.json');
  const token = randomBytes(24).toString('hex');
  writeFileSync(proofPath, '', { mode: 0o600 });
  try {
    const result = await hostThroughPty({
      command: process.execPath, args: ['-e', childCode], cwd: process.cwd(), ownerId,
      env: hermeticEnv({ PAPERCUSP_AGENT: 'claude', PAPERCUSP_SID: ownerId,
        PAPERCUSP_PSU_HEADLESS: '1',
        [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: token }),
      kickoff: 'This must not be submitted to an exited child.',
      io: { stdin, stdout }, bridgeTty: false, onExit: () => {},
    });
    expect(result).toBe(exitCode);
    const receipt = await vi.waitFor(() => JSON.parse(readFileSync(proofPath, 'utf8')), { timeout: 3000 });
    expect(receipt).toEqual({ token, persisted: false, nativeRef: null,
      reason: `kickoff-not-submitted:native-child-exited:exit=${exitCode};signal=${signal ?? 'none'}` });
    expect(JSON.stringify(receipt)).not.toContain(outputMarker);
    const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const spawn = events.find(row => row.kind === 'pty-spawned');
    const exits = events.filter(row => row.kind === 'pty-child-exited');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ childPid: spawn.childPid, agent: 'claude', generation: 1,
      exitCode, signal, normalizedLogPath: null });
    expect(exits[0].msSinceSpawn).toBeGreaterThanOrEqual(0);
    expect(exits[0].outputBytes > 0).toBe(withOutput);
    expect(output.includes(outputMarker)).toBe(withOutput);
    expect(JSON.stringify(exits)).not.toContain(outputMarker);
    expect(exits[0]).not.toHaveProperty('output');
    expect(events.findIndex(row => row.kind === 'pty-child-exited')).toBeGreaterThan(
      events.findIndex(row => row.kind === 'pty-spawned'));
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
  }
}, 15_000);

it('keeps host-initiated kickoff teardown distinct from a native startup failure', async () => {
  const ownerId = `test-host-exit-${process.pid}-${Date.now()}`;
  const proofDir = mkdtempSync(join(tmpdir(), 'host-exit-proof-'));
  const proofPath = join(proofDir, 'receipt.json');
  const token = randomBytes(24).toString('hex');
  writeFileSync(proofPath, '', { mode: 0o600 });
  const signalSource = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30, write() { return true; } };
  const done = hostThroughPty({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000);'], cwd: process.cwd(), ownerId,
    env: hermeticEnv({ PAPERCUSP_AGENT: 'claude', PAPERCUSP_SID: ownerId,
      PAPERCUSP_PSU_HEADLESS: '1',
      [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: token }),
    kickoff: 'This must not be submitted during host shutdown.',
    io: { stdin, stdout }, bridgeTty: false, signalSource, onExit: () => {},
  });
  try {
    signalSource.emit('SIGTERM');
    await done;
    const receipt = await vi.waitFor(() => JSON.parse(readFileSync(proofPath, 'utf8')), { timeout: 3000 });
    expect(receipt).toEqual({ token, persisted: false, nativeRef: null,
      reason: 'kickoff-not-submitted:host-ended' });
  } finally {
    signalSource.emit('SIGTERM');
    await done;
    rmSync(proofDir, { recursive: true, force: true });
  }
}, 15_000);

it('keeps the native-output fixtures publishable by the secret guard', () => {
  const path = 'apps/operator/lib/psu-pty-host-native-bootstrap.integration.test.ts';
  expect(scanTextForSecrets(path, readFileSync(new URL(import.meta.url), 'utf8'))).toEqual([]);
});
