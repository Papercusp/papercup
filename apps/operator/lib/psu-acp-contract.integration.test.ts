import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureNode } from '../scripts/psu-acp/fixtures/fixture-node';

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

async function invokeClient(cwd: string, args: string[], env = process.env,
  command = [process.execPath, '--input-type=module', '--eval', peer]) {
  const python = env.PSU_ACP_TEST_PYTHON;
  const prefix = python ? [client] : ['run', '--no-project', '--script', client];
  return run(python || 'uv', [...prefix, '--cwd', cwd, ...args, '--', ...command], { env, timeout: 75_000 });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('pinned native ACP reference', () => {
  const endpoint = process.env.DOCKER_HOST || 'unix:///run/docker-bench.sock';
  const docker = (...args: string[]) => run('docker', ['--host', endpoint, ...args], { timeout: 90_000 });
  const node = '/usr/local/bin/node';
  const nodeMount = 'type=bind,src=' + fixtureNode() + ',dst=' + node + ',readonly';
  let oracle: string;

  beforeAll(async () => {
    const image = (await docker('build', '--network=none', '--pull=false', '--quiet', fixtures)).stdout.trim();
    await docker('run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', nodeMount, image, node, '--version');
    oracle = await mkdtemp(join(tmpdir(), 'psu-acp-reference-'));
    const source = join(fixtures, 'reference');
    await Promise.all(['package.json', 'package-lock.json', 'provider.mjs'].map(name =>
      copyFile(join(source, name), join(oracle, name))));
    await run('npm', ['ci', '--include=optional', '--ignore-scripts', '--prefer-offline',
      '--no-audit', '--no-fund', '--workspaces=false'], { cwd: oracle, timeout: 120_000 });
    await chmod(oracle, 0o755);
  }, 130_000);

  afterAll(async () => { if (oracle) await rm(oracle, { recursive: true, force: true }); });

  it.each([
    { profile: 'core', decision: 'none' }, { profile: 'hooks', decision: 'none' },
    { profile: 'core', decision: 'allow_once' }, { profile: 'core', decision: 'reject_once' },
    { profile: 'core', decision: 'cancelled' },
  ])('runs a native reference turn under $profile with $decision', async ({ profile, decision }) => {
    const image = (await docker('build', '--network=none', '--pull=false', '--quiet',
      '--build-arg', 'PROFILE=' + profile, fixtures)).stdout.trim();
    const native = '/oracle/node_modules/@anthropic-ai/claude-agent-sdk-linux-' + process.arch + '/claude';
    const adapter = '/oracle/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js';
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { stdout } = await docker('run', '-d', '--network', 'none', '--memory', '8g', '--memory-swap', '8g',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,src=' + oracle + ',dst=/oracle,readonly',
      '--mount', nodeMount,
      '-e', 'CLAUDE_CODE_EXECUTABLE=' + native, '-e', 'AWS_REGION=us-east-1',
      '-e', 'FIXTURE_MCP_TOKEN_SHA256=' + tokenHash,
      '-e', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH=1', '-e', 'ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:8911',
      image, node, '/oracle/provider.mjs');
    const container = stdout.trim();
    try {
      const exec = (...args: string[]) => docker('exec', container, ...args);
      await vi.waitFor(async () => {
        await exec(node, '--input-type=module', '--eval',
          "if (!(await fetch('http://127.0.0.1:8911/ready')).ok) process.exit(1)");
      }, { timeout: 10_000, interval: 100 });
      const policy = '/etc/claude-code/managed-settings.json';
      expect((await exec('id', '-u')).stdout.trim()).toBe('65534');
      expect((await exec('stat', '-c', '%u:%g %a', policy)).stdout.trim()).toBe('0:0 444');
      expect((await exec('cat', policy)).stdout).toBe(await readFile(join(fixtures, 'managed-' + profile + '.json'), 'utf8'));
      const version = (await exec(native, '--version')).stdout.trim();
      expect(version).toMatch(/^2\.1\.293\b/);
      const scenario = decision === 'none' ? profile : profile + '-' + decision;
      const prompt = join(oracle, scenario + '.txt');
      await writeFile(prompt, decision === 'none' ? 'Return the managed fixture receipt.' :
        'Return the managed fixture receipt and exercise the fixture Write.');
      const invocation = ['docker', '--host', endpoint, 'exec', '-i', container, node, adapter];
      const choice = ['allow_once', 'reject_once'].includes(decision) ? ['--fixture-decision', decision] : [];
      const credential = join(oracle, scenario + '.token');
      await writeFile(credential, token, { mode: 0o600 });
      const probe = await invokeClient('/work', ['--launch-cwd', oracle, '--expect-adapter-version', '0.88.0',
        '--effort', 'low', '--prompt-timeout', '45', '--prompt-file', prompt,
        '--fixture-mcp-token-file', credential, ...choice], process.env, invocation);
      const trace = JSON.parse(probe.stdout);
      const provider = (await exec('cat', '/work/provider-requests.jsonl')).stdout.trim().split('\n')
        .map(line => JSON.parse(line));
      const mcp = (await exec('cat', '/work/mcp-requests.jsonl')).stdout.trim().split('\n').map(line => JSON.parse(line));
      const evidence = process.env.PSU_ACP_TRACE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, 'reference-' + scenario + '.json'),
          JSON.stringify({ profile, decision, image, version, invocation, provider, mcp, trace }, null, 2) + '\n', { flag: 'wx' });
      }
      expect(mcp).toEqual(expect.arrayContaining(['initialize', 'tools/list'].map(method => ({ method, digest: tokenHash }))));
      expect(probe.stdout + probe.stderr).not.toContain(token);
      expect(trace).toMatchObject({ protocolVersion: 1, adapter: { version: '0.88.0' },
        initialConfig: { mode: 'auto' }, selectedConfig: { effort: 'low' },
        result: { stopReason: 'end_turn' } });
      if (decision !== 'none') {
        const receipt = '/work/permission-receipt.txt';
        expect(provider).toContainEqual(expect.objectContaining({ emittedToolId: 'toolu_psu_acp_receipt' }));
        expect(trace.permissions).toEqual([{ sessionId: trace.sessionId, toolCallId: 'toolu_psu_acp_receipt', decision }]);
        const states = trace.updates.map(({ update }: { update: { toolCallId?: string; status?: string } }) => update)
          .filter((update: { toolCallId?: string; status?: string }) => update.toolCallId === 'toolu_psu_acp_receipt' && update.status)
          .map((update: { status: string }) => update.status);
        expect(states[0]).toBe('pending');
        expect(states.at(-1)).toBe(decision === 'allow_once' ? 'completed' : 'failed');
        if (decision === 'allow_once') expect((await exec('cat', receipt)).stdout).toBe('approved fixture receipt\n');
        else await exec('test', '!', '-e', receipt);
        return;
      }
      expect(trace.permissions).toEqual([]);
      const replies: string[] = [];
      for (const { update } of trace.updates) {
        if (update.sessionUpdate !== 'agent_message_chunk') continue;
        if (update._meta?.claudeCode?.kind === 'informational') {
          expect(update.content.text).not.toBe('');
          continue;
        }
        expect(provider).toContainEqual(expect.objectContaining({
          messageId: update.messageId, containsProbe: true, effort: 'low',
        }));
        replies.push(update.content.text);
      }
      expect(replies.join('')).toBe('Native managed fixture completed.\n/work/result.txt');
      expect(trace.result.usage).toMatchObject({ totalTokens: 22, inputTokens: 14, outputTokens: 8 });
    } finally {
      await docker('rm', '-f', container);
      expect((await docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + container)).stdout.trim()).toBe('');
    }
  }, 140_000);
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
