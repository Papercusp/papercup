// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, socketPathFor, nativeLatestExecution } from '../scripts/psu-pty-host.mjs';
import { injectIntoHostWithConfirmation } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let ownerCounter = 0;
async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(20);
  expect(check()).toBe(true);
}

/** Real PTY and socket, sanitized native event shapes, no model or live DB. */
async function fixture(agent: string, autoStart: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'loop-native-recovery-'));
  const config = join(root, '.papercusp', `session-${agent}`);
  const nativeDir = agent === 'omp' ? join(config, 'agent', 'sessions')
    : join(config, agent === 'claude' ? 'projects' : 'sessions');
  const transcript = join(nativeDir, 'fixture.jsonl');
  mkdirSync(nativeDir, { recursive: true });
  if (agent === 'codex') writeFileSync(join(config, 'config.toml'), '');
  const ownerId = `rx-${process.pid}-${agent[0]}-${++ownerCounter}`;
  const sock = socketPathFor(ownerId);
  expect(Buffer.byteLength(sock), 'fixture Unix socket path must fit the platform bound').toBeLessThan(104);
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30, write(chunk: string) { output += chunk; return true; } };
  const code = `
    const fs = require('node:fs');
    const agent = ${JSON.stringify(agent)}, path = ${JSON.stringify(transcript)};
    let line = '', count = 0, pending = false;
    function append(row) { fs.appendFileSync(path, JSON.stringify({...row, timestamp: new Date().toISOString()})+'\\n'); }
    function start() {
      if (!pending) return; pending = false;
      append(agent === 'codex' ? {type:'event_msg',payload:{type:'task_started'}} :
        agent === 'claude' ? {type:'assistant',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'working'}]}} :
        {type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'working'}]}});
      process.stdout.write('NATIVE_STARTED\\n');
    }
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { for (const c of data) {
      if (c === '\\x04') { process.exit(0); return; }
      if (c === '\\x12') { start(); continue; }
      if (c === '\\r') {
        if (!line) continue;
        append(agent === 'codex' ? {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}} :
          agent === 'claude' ? {type:'user',message:{role:'user',content:line}} :
          {type:'message',message:{role:'user',content:[{type:'text',text:line}]}});
        pending = true; line = ''; process.stdout.write('SUBMIT:'+(++count)+'\\n');
        if (${autoStart}) setTimeout(start, 40);
      } else line += c;
    }});
    process.stdout.write('READY\\n'); setTimeout(()=>process.exit(0),15000);
  `;
  const env = hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: agent,
    ...(agent === 'codex' ? { CODEX_HOME: config } : agent === 'claude' ? { CLAUDE_CONFIG_DIR: config } : { PI_CONFIG_DIR: config }),
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '10', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '100',
    PAPERCUSP_PSU_PTY_NATIVE_START_TIMEOUT_MS: '250',
    PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10', PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
  });
  // Fail before spawning a child when the real adapter cannot read this root.
  const settled = agent === 'codex' ? { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture' } }
    : agent === 'claude' ? { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }
      : { type: 'message', message: { role: 'assistant', stopReason: 'stop' } };
  writeFileSync(transcript, JSON.stringify({ ...settled, timestamp: new Date().toISOString() }) + '\n');
  expect(nativeLatestExecution({ agent, env }).phase, `${agent} fixture native root preflight`).toBe('settled');
  const done = hostThroughPty({ command: process.execPath, args: ['-e', code], cwd: root,
    ownerId, env, io: { stdin, stdout }, bridgeTty: false, onExit: () => {} });
  await until(() => output.includes('READY') && existsSync(metaPathFor(ownerId)) && existsSync(sock));
  const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  expect(meta.execution, `${agent} metadata must carry native observation`).toBeDefined();
  const message = { mode: 'turn' as const, ownerId, deliveryId: `native-${agent}`, requireNativeTurnStart: true,
    expectedChildGeneration: meta.execution.childGeneration, expectedHostStartedAt: meta.startedAt,
    data: '⟦turn-origin:loop-fire nonce:1234567890abcdef⟧\nContinue approved recovery.' };
  return { message, sock, output: () => output, async close() {
    await injectIntoHostWithConfirmation(sock, { mode: 'raw', ownerId, data: '\x04' }).catch(() => null);
    await done;
    expect(existsSync(metaPathFor(ownerId))).toBe(false);
    expect(existsSync(sock)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  } };
}

describe('cross-client native recovery handshake', () => {
  it.each(['codex', 'claude', 'omp'])('requires a native %s turn and deduplicates repeated delivery', async agent => {
    const f = await fixture(agent, true);
    try {
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.output().includes('NATIVE_STARTED'));
      let confirmed = false;
      for (let n = 0; n < 20 && !confirmed; n++) {
        const result = await injectIntoHostWithConfirmation(f.sock, f.message);
        confirmed = result.reason === 'duplicate-delivery-id';
        if (!confirmed) await delay(30);
      }
      expect(confirmed).toBe(true);
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 25_000);

  it.each(['codex', 'claude', 'omp'])('keeps a %s prompt without model activity pending across retries', async agent => {
    const f = await fixture(agent, false);
    try {
      await injectIntoHostWithConfirmation(f.sock, f.message);
      await until(() => f.output().includes('SUBMIT:1'));
      await delay(350);
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ reason: 'pending-delivery-id' });
      expect(f.output()).not.toContain('SUBMIT:2');
      await injectIntoHostWithConfirmation(f.sock, { mode: 'raw', ownerId: f.message.ownerId, data: '\x12' });
      await until(() => f.output().includes('NATIVE_STARTED'));
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ reason: 'duplicate-delivery-id' });
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 25_000);

  it('refuses an older child generation without writing a prompt', async () => {
    const f = await fixture('codex', true);
    try {
      await injectIntoHostWithConfirmation(f.sock, { ...f.message, expectedChildGeneration: 99 });
      await delay(300);
      expect(f.output()).not.toContain('SUBMIT:');
    } finally { await f.close(); }
  }, 25_000);
});
