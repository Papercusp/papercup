/**
 * Regression coverage for the Claude native edit-batch lock lifecycle.
 *
 * PreToolUse writes one batch state plus one marker per native edit. PostToolUse
 * must leave those artifacts alone while the batch is in flight; PostToolBatch
 * is the only hook allowed to release the union, and only after it sees every
 * expected edit in a terminal granted state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

const BATCH_HOOK = join(__dirname, '..', 'posttoolbatch-locks-release.sh');
const POST_HOOK = join(__dirname, '..', 'posttooluse-locks-release.sh');

let home: string;
let cache: string;
let server: Server;
let operatorUrl: string;
let releaseRequests: Array<Record<string, any>> = [];

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'posttoolbatch-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'posttoolbatch-cache-'));

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, any>;
      releaseRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  operatorUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
});

afterEach(() => {
  releaseRequests = [];
  for (const name of fs.readdirSync(cache)) fs.rmSync(join(cache, name), { force: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

function runHook(script: string, input: Record<string, unknown>) {
  return runHookProcess('bash', [script], {
    input: JSON.stringify(input),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_OPERATOR_URL: operatorUrl,
      http_proxy: undefined,
      https_proxy: undefined,
    },
  });
}

function writeBatch(
  batchId: string,
  status: string,
  toolUseIds: string[],
  options: { markerStatuses?: Record<string, string>; owner?: string } = {},
) {
  const owner = options.owner ?? 'batch-owner';
  fs.writeFileSync(
    join(cache, `batch-${batchId}.state.json`),
    JSON.stringify({
      version: 1,
      batch_id: batchId,
      status,
      transcript_path: '/tmp/claude-transcript.jsonl',
      tool_use_ids: toolUseIds,
      paths: ['src/first.ts', 'src/second.ts'],
      owner,
      lock_id: 'batch-lock',
      release_paths: ['src/first.ts', 'src/second.ts'],
      coordination_domain: '/repo',
    }),
  );
  for (const toolUseId of toolUseIds) {
    fs.writeFileSync(
      join(cache, `${toolUseId}.batch`),
      JSON.stringify({
        batch_id: batchId,
        tool_use_id: toolUseId,
        status: options.markerStatuses?.[toolUseId] ?? status,
        owner,
      }),
    );
  }
  fs.writeFileSync(join(cache, `batch-${batchId}.leader`), '{}');
}

function batchInput(toolUseIds: string[], owner = 'batch-owner') {
  return {
    hook_event_name: 'PostToolBatch',
    session_id: owner,
    tool_calls: toolUseIds.map((tool_use_id) => ({ tool_use_id })),
  };
}

function expectClean(batchId: string, toolUseIds: string[]) {
  expect(fs.existsSync(join(cache, `batch-${batchId}.state.json`))).toBe(false);
  expect(fs.existsSync(join(cache, `batch-${batchId}.state.json.processing`))).toBe(false);
  expect(fs.existsSync(join(cache, `batch-${batchId}.leader`))).toBe(false);
  for (const toolUseId of toolUseIds)
    expect(fs.existsSync(join(cache, `${toolUseId}.batch`))).toBe(false);
}

describe('posttoolbatch-locks-release.sh', () => {
  it('releases exactly once for a complete granted batch and cleans its artifacts', async () => {
    writeBatch('complete', 'granted', ['tu-first', 'tu-second']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-first', 'tu-second', 'tu-read']));

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.params).toMatchObject({
      name: 'locks:release',
      arguments: {
        lock_id: 'batch-lock',
        paths: ['src/first.ts', 'src/second.ts'],
        coordination_domain: '/repo',
      },
    });
    expectClean('complete', ['tu-first', 'tu-second']);
  });

  it.each(['allowed', 'denied'])('does not release a terminal %s batch but cleans it', async (status) => {
    writeBatch(status, status, ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one', 'tu-two']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean(status, ['tu-one', 'tu-two']);
  });

  it('does not release a partial payload, even when the stored state is granted, and cleans it', async () => {
    writeBatch('partial', 'granted', ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('partial', ['tu-one', 'tu-two']);
  });

  it('does not release when one marker is not granted, and still cleans the batch', async () => {
    writeBatch('marker-denied', 'granted', ['tu-one', 'tu-two'], {
      markerStatuses: { 'tu-two': 'denied' },
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one', 'tu-two']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('marker-denied', ['tu-one', 'tu-two']);
  });
});

describe('posttooluse-locks-release.sh batch deferral', () => {
  it('leaves the per-tool release token untouched while a batch marker exists', async () => {
    const toolUseId = 'tu-deferred';
    writeBatch('deferred', 'granted', [toolUseId]);
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), 'per-tool-lock');
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(['src/first.ts']));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), '/repo');

    const out = await runHook(POST_HOOK, { tool_use_id: toolUseId, session_id: 'batch-owner' });

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(0);
    expect(fs.readFileSync(join(cache, `${toolUseId}.lock`), 'utf8')).toBe('per-tool-lock');
    expect(fs.existsSync(join(cache, `${toolUseId}.paths`))).toBe(true);
    expect(fs.existsSync(join(cache, `${toolUseId}.domain`))).toBe(true);
  });
});
