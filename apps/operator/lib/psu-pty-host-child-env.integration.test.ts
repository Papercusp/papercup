// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { materializePsuClaudeMcpConfig } from '../scripts/psu-launcher.mjs';
import { hostThroughPty, socketPathFor, eventLogPathForOwner } from '../scripts/psu-pty-host.mjs';
import { injectIntoHostWithConfirmation } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';

// WI-6554700010050184: a carry-respawn rotates the native session id. The
// per-session Claude MCP config holds that id as a LITERAL header, so it must be
// re-materialized from the env of EVERY child spawn. Measured failure: the
// successor kept presenting its predecessor's id and every MCP call was refused
// `superuser_foreign_native_session`. The child here is an isolated node
// fixture, not a model session.
it('re-materializes the native-session MCP header for a carry-respawn successor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-child-env-'));
  const ownerId = `test-child-env-${process.pid}-${Date.now()}`;
  const home = join(root, 'home');
  const sessions = join(root, 'sessions');
  const dir = join(sessions, ownerId);
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'papercusp-su': {
    type: 'http',
    url: 'http://127.0.0.1:9071/api/mcp?superuser=1&client=${PAPERCUSP_SID:-bare}',
    headers: { Authorization: 'Bearer FIXTURE', 'x-papercusp-native-session': '${PAPERCUSP_NATIVE_SESSION_ID:-}' },
  } } }));
  symlinkSync(join(home, '.claude.json'), join(dir, '.claude.json'));
  const priorSessions = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
  process.env.PAPERCUSP_SESSION_CLAUDE_DIR = sessions;
  const header = () => JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
    .mcpServers['papercusp-su'].headers['x-papercusp-native-session'];

  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30,
    write(chunk: string) { output += chunk; return true; } };
  const signalSource = new EventEmitter();
  const env = hermeticEnv({ PAPERCUSP_SID: ownerId, CLAUDE_CONFIG_DIR: dir,
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '30', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '500',
    PAPERCUSP_PSU_PTY_REARM_CAP_MS: '1000' });
  const childCode = "process.stdout.write('CHILD-READY\\n');process.stdin.resume();" +
    'setTimeout(()=>process.exit(0),15000);';
  const argsFor = (id: string) => ['-e', childCode, '--', '--session-id', id];
  const seen: Array<string | undefined> = [];
  const prepareChildEnv = vi.fn((childEnv: Record<string, string | undefined>) => {
    seen.push(childEnv.PAPERCUSP_NATIVE_SESSION_ID);
    materializePsuClaudeMcpConfig(childEnv, { home });
  });
  const done = hostThroughPty({ command: process.execPath, args: argsFor(first),
    cwd: root, env, ownerId, io: { stdin, stdout }, signalSource, bridgeTty: false,
    onExit: () => {}, prepareChildEnv,
    mintCarryRespawnArgs: () => ({ args: argsFor(second), nativeId: second }) });
  const socket = socketPathFor(ownerId);
  const log = eventLogPathForOwner(ownerId);
  const events = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  try {
    await vi.waitFor(() => expect(output).toContain('CHILD-READY'), { timeout: 10000 });
    expect(seen).toEqual([first]);
    expect(header()).toBe(first);
    expect(await injectIntoHostWithConfirmation(socket, { mode: 'carry-respawn', ownerId,
      data: 'isolated carry fixture', systemPromptAddendum: 'isolated carry fixture',
      deliveryId: `child-env-${ownerId}` })).toMatchObject({ ok: true, reason: 'accepted' });
    await vi.waitFor(() => expect(events().filter(event => event.kind === 'pty-spawned')).toHaveLength(2),
      { timeout: 12000 });
    expect(seen).toEqual([first, second]);
    // The decisive assertion: the successor's on-disk carrier names ITS id.
    expect(header()).toBe(second);
    expect(events().some(event => event.kind === 'child-env-prepare-failed')).toBe(false);
  } finally {
    signalSource.emit('SIGTERM');
    await done;
    if (priorSessions === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = priorSessions;
    rmSync(root, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
}, 30000);
