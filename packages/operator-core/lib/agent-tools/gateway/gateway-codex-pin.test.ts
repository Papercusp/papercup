/**
 * gateway-codex-pin.test.ts — regression coverage for EI-21719545129987944.
 *
 * `gateway:status` exposes separate Claude (`accounts`) and Codex (`codexAccounts`)
 * pools. `accounts:pin` must validate a named account against both lists, otherwise
 * a confirmed Codex account is rejected before the durable owner pin is written.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';

const writes: Array<{ workspaceId: string; ownerId: string; account: string; hard: boolean }> = [];

vi.mock('../../deployment/account-owner-pins', () => ({
  setOwnerPin: async (workspaceId: string, ownerId: string, pin: { account: string; hard: boolean }) => {
    writes.push({ workspaceId, ownerId, account: pin.account, hard: pin.hard });
    return pin;
  },
  clearOwnerPin: vi.fn(),
}));

const { accountsPinTool } = await import('./gateway');

const body = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
const previousPort = process.env.PAPERCUSP_GATEWAY_PORT;
let server: http.Server | undefined;

async function startGateway(config: { accounts?: string[]; codexAccounts?: string[] }): Promise<void> {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/admin/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/owner-pin') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server.address() as { port: number }).port);
}

beforeEach(() => {
  writes.length = 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
});

test('accepts a named Codex account from the gateway codexAccounts pool', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['aviynw5_codex'] });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-codex-owner', account: 'aviynw5_codex' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.appliedLive, true);
  assert.deepEqual(writes, [
    { workspaceId: 'papercusp-workspace', ownerId: 'su-codex-owner', account: 'aviynw5_codex', hard: false },
  ]);
});

test('retains named Claude account acceptance from the accounts pool', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['codex-main'] });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-claude-owner', account: 'claude-main' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.account, 'claude-main');
});

test('rejects a named account absent from both gateway pools before durable write', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['codex-main'] });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-unknown-owner', account: 'missing-account' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /missing-account.*not in the gateway pool/);
  assert.deepEqual(result.accounts, ['claude-main', 'codex-main']);
  assert.equal(writes.length, 0);
});
