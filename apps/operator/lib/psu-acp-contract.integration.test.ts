import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const client = fileURLToPath(new URL('../scripts/psu-acp/contract_client.py', import.meta.url));
const fixtures = fileURLToPath(new URL('../scripts/psu-acp/fixtures/', import.meta.url));
const directories: string[] = [];

// A controlled protocol peer exercises the differential client's measurements.
// The pinned reference and the built candidate can both use the same client.
const peer = `
  import { createInterface } from 'node:readline';
  const sid = '11223344-5566-4788-9abc-0123456789ab';
  const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const option = value => [{ id: 'effort', name: 'Effort', type: 'select', currentValue: value,
    options: ['default', 'low'].map(value => ({ value, name: value })) }];
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    let result;
    if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {},
      agentInfo: { name: 'contract-fixture', version: '1' } };
    else if (method === 'session/new') result = { sessionId: sid, configOptions: option('default') };
    else if (method === 'session/set_config_option') result = {
      configOptions: option(process.env.FIXTURE_WRONG_EFFORT === '1' ? 'default' : params.value) };
    else if (method === 'session/prompt') {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: params.prompt[0].text } } } });
      result = { stopReason: 'end_turn' };
    } else if (method === 'session/close') result = {};
    else { write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } }); continue; }
    write({ jsonrpc: '2.0', id, result });
  }
`;

async function invokeClient(cwd: string, args: string[], env = process.env) {
  const python = env.PSU_ACP_TEST_PYTHON;
  const prefix = python ? [client] : ['run', '--no-project', '--script', client];
  return run(python || 'uv', [...prefix, '--cwd', cwd, ...args, '--', process.execPath,
    '--input-type=module', '--eval', peer], { env, timeout: 75_000 });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('psu ACP differential client', () => {
  it('records the negotiated configuration and the complete UTF-8 prompt observation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psu-acp-probe-'));
    directories.push(dir);
    const prompt = 'Message\r\n`quoted` — 路徑\n/path/to/result\n';
    const file = join(dir, 'input.txt');
    await writeFile(file, prompt);
    const { stdout } = await invokeClient(dir, ['--expect-adapter-version', '1', '--effort', 'low', '--prompt-file', file]);
    const trace = JSON.parse(stdout);
    expect(trace).toMatchObject({ clientVersion: '0.12.1', protocolVersion: 1,
      adapter: { name: 'contract-fixture' }, initialConfig: { effort: 'default' },
      selectedConfig: { effort: 'low' }, permissions: [], result: { stopReason: 'end_turn' } });
    expect(trace.updates).toEqual([{ sessionId: trace.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prompt } } }]);
  }, 90_000);

  it('fails the measurement when the peer reports a different selected effort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psu-acp-probe-'));
    directories.push(dir);
    await expect(invokeClient(dir, ['--effort', 'low'], { ...process.env, FIXTURE_WRONG_EFFORT: '1' }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('effort readback differs') });
  }, 90_000);

  it('keeps managed permission policy identical in both fixture profiles', async () => {
    const profiles = await Promise.all(['core', 'hooks'].map(async name =>
      JSON.parse(await readFile(join(fixtures, `managed-${name}.json`), 'utf8'))));
    const [{ hooks: coreHooks, ...core }, { hooks: managedHooks, ...managed }] = profiles;
    expect(core).toEqual(managed);
    expect(core).toMatchObject({ allowManagedHooksOnly: true, allowManagedPermissionRulesOnly: true,
      permissions: { defaultMode: 'auto', disableBypassPermissionsMode: 'disable', allow: [] } });
    expect(coreHooks).toEqual({});
    expect(managedHooks.PreToolUse.map((entry: { matcher: string }) => entry.matcher)).toEqual(['Bash', 'Agent']);
  });
});
