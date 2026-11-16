// @vitest-environment node
// WI-6554700010050275: exercise the installed TUI, not an emulator that treats
// every CR as submission. The local Responses fixture never uses credentials.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, KICKOFF_PROOF_PATH_ENV, KICKOFF_PROOF_TOKEN_ENV } from '../scripts/psu-pty-host.mjs';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge';

it.each([0, 5000])('starts an idle Codex kickoff exactly once with MCP bootstrap delayed %ims', async mcpDelayMs => {
  const root = mkdtempSync(join(tmpdir(), 'codex-idle-kickoff-'));
  const codexHome = join(root, 'home');
  mkdirSync(codexHome);
  const ownerId = `test-codex-kickoff-${randomUUID()}`;
  const marker = `⟦turn-origin:fleet-kickoff nonce:${randomBytes(8).toString('hex')}⟧`;
  const kickoff = `${marker}\nRecover the existing fleet lane.\nPaper only; retain the existing signing key.\nDECISIVE_KICKOFF_TAIL`;
  const proofPath = join(root, 'kickoff.json');
  writeFileSync(proofPath, '', { mode: 0o600 });
  const signals = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  let output = '';
  const requests: any[] = [];
  const errors: string[] = [];
  let nativeExit: number | undefined;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.url === '/mcp') {
        const rpc = JSON.parse(Buffer.concat(chunks).toString());
        if (rpc.id === undefined) { res.writeHead(202).end(); return; }
        if (rpc.method === 'initialize' && mcpDelayMs) {
          await new Promise(resolve => setTimeout(resolve, mcpDelayMs));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
            serverInfo: { name: 'kickoff-fixture', version: '1' } }
          : rpc.method === 'tools/list' ? { tools: [] } : {} }));
        return;
      }
      if (req.url !== '/v1/responses') { res.writeHead(200).end('{}'); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: 'gpt-6.1-sol',
        text: 'OFFLINE_KICKOFF_COMPLETE', inputTokens: 0, outputTokens: 0 })));
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  let done: Promise<number> | undefined;
  try {
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1',
      () => resolve((server.address() as { port: number }).port)));
    writeFileSync(join(codexHome, 'config.toml'),
      `[mcp_servers.papercusp-su]\nurl = "http://127.0.0.1:${port}/mcp"\nrequired = true\n`);
    const overrides = { model: 'gpt-6.1-sol', model_provider: 'kickoff_fixture',
      'model_providers.kickoff_fixture.name': 'Offline kickoff regression',
      'model_providers.kickoff_fixture.base_url': `http://127.0.0.1:${port}/v1`,
      'model_providers.kickoff_fixture.wire_api': 'responses',
      'model_providers.kickoff_fixture.requires_openai_auth': false,
      'model_providers.kickoff_fixture.supports_websockets': false,
      'model_providers.kickoff_fixture.request_max_retries': 0,
      'model_providers.kickoff_fixture.stream_max_retries': 0,
      'features.apps': false, 'features.hooks': false, 'features.plugins': false,
      web_search: 'disabled', check_for_update_on_startup: false,
      [`projects.${JSON.stringify(root)}.trust_level`]: 'trusted' };
    done = hostThroughPty({ command: 'codex',
      args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
        ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
      cwd: root, ownerId, kickoff,
      env: hermeticEnv({ CODEX_HOME: codexHome, TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
        PAPERCUSP_SID: ownerId, PAPERCUSP_PSU_HEADLESS: '1',
        // Exercise real native proof with the same 30s generic verification
        // budget, without depending on a 5s polling phase or the independently
        // covered provider-quota grace (this provider is entirely local).
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS: '100',
        PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS: '300',
        PAPERCUSP_PSU_PTY_KICKOFF_QUOTA_GRACE_MS: '100',
        [KICKOFF_PROOF_PATH_ENV]: proofPath, [KICKOFF_PROOF_TOKEN_ENV]: randomBytes(24).toString('hex') }),
      signalSource: signals, emitCompacted: () => null, onExit: () => {}, bridgeTty: false,
      io: { stdin, stdout: { isTTY: false, columns: 120, rows: 40,
        write(data: string) { output += data; return true; } } },
    });
    void done.then(code => { nativeExit = code; });
    const transcript = () => {
      try {
        return readdirSync(join(codexHome, 'sessions'), { recursive: true })
          .map(String).filter(path => path.endsWith('.jsonl'))
          .map(path => readFileSync(join(codexHome, 'sessions', path), 'utf8')).join('\n');
      } catch { return ''; }
    };
    const diagnostics = () => JSON.stringify({ errors, requests: requests.length,
      outputPreview: output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-1200),
      nativeRows: transcript().split('\n').filter(Boolean).map(line => {
        const row = JSON.parse(line);
        return { type: row.type, payloadType: row.payload?.type, role: row.payload?.role };
      }) });
    await vi.waitFor(() => {
      expect(nativeExit, diagnostics()).toBeUndefined();
      expect(transcript(), diagnostics()).toContain('OFFLINE_KICKOFF_COMPLETE');
    }, { timeout: 25_000 });
    const rows = transcript().split('\n').filter(Boolean).map(line => JSON.parse(line));
    // Current Codex stores accepted input as a semantic user message; an
    // event_msg/user_message notification is optional and is not the ledger.
    const prompts = rows.filter(row => row.type === 'response_item' && row.payload?.role === 'user')
      .map(row => row.payload.content?.filter((item: any) => item.type === 'input_text')
        .map((item: any) => item.text).join('\n'))
      .filter((text: string | undefined) => text?.includes(marker));
    expect(prompts, diagnostics()).toHaveLength(1);
    expect(prompts[0]).toBe(kickoff);
    // The receipt must follow real native persistence, not the TUI repaint.
    await vi.waitFor(() => {
      const receipt = readFileSync(proofPath, 'utf8');
      expect(receipt, diagnostics()).not.toBe('');
      expect(JSON.parse(receipt)).toMatchObject({ persisted: true });
    }, { timeout: 35_000 });
    expect(errors).toEqual([]);
  } finally {
    signals.emit('SIGTERM');
    await done;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 70_000);
