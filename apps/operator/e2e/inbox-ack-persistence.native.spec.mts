import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeNativeBridgeJson } from './_native-bridge-json';

type AttentionRecord = {
  id?: string;
  kind?: string;
  title?: string;
  ref?: { msgId?: string };
  [key: string]: unknown;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the isolated Inbox acceptance`);
  return value;
}

function decodeMcpOutput(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout.trim()) as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  };
  if (envelope.structuredContent) return envelope.structuredContent;
  const textPart = envelope.content?.find((part) => part.type === 'text')?.text;
  return textPart ? JSON.parse(textPart) as Record<string, unknown> : envelope as Record<string, unknown>;
}

function collectAttention(value: unknown, into: AttentionRecord[] = []): AttentionRecord[] {
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const child of value) collectAttention(child, into);
    return into;
  }
  const record = value as AttentionRecord;
  if (record.kind === 'coord-message' && typeof record.id === 'string') {
    into.push(record);
    return into;
  }
  for (const child of Object.values(record)) collectAttention(child, into);
  return into;
}

function findMessage(result: unknown, msgId: string): AttentionRecord | null {
  const expectedId = `coord-message:${msgId}`;
  return collectAttention(result).find((item) =>
    item.id === expectedId || item.ref?.msgId === msgId) ?? null;
}

function sentMessageId(result: Record<string, unknown>, label: string): string {
  // coord:send uses the shared bulk envelope even for a single message.
  // Keep direct fields for older callers, but read the per-message result
  // when the current envelope is returned.
  const firstResult = Array.isArray(result.results)
    ? result.results[0] as Record<string, unknown> | undefined
    : undefined;
  if (firstResult?.ok === false) {
    throw new Error(`${label} send failed: ${JSON.stringify(firstResult)}`);
  }
  const id = firstResult?.msg_id ?? firstResult?.msgId ?? result.msg_id ?? result.msgId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${label} send returned no message id: ${JSON.stringify(result).slice(0, 1200)}`);
  }
  return id;
}

function testIdSelector(testId: string): string {
  return `[data-testid=${JSON.stringify(testId)}]`;
}

test('native Inbox acknowledgement removes only the selected message after refresh and reload', async ({}, info) => {
  test.setTimeout(240_000);

  const sessionId = requiredEnv('PAPERCUSP_SID');
  const workspaceId = requiredEnv('PAPERCUSP_WORKSPACE_ID');
  const port = requiredEnv('VERIFY_TAURI_PORT');
  const origin = requiredEnv('VERIFY_TAURI_DEV_URL');
  const bridge = requiredEnv('VERIFY_TAURI_AGENT_TOOLS_BIN');
  const pid = requiredEnv('VERIFY_TAURI_PID');
  const runGroup = requiredEnv('PAPERCUSP_TEST_RUN_GROUP');
  const receiptPath = requiredEnv('PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE');
  const reporterReceiptPath = requiredEnv('PAPERCUSP_TEST_RUN_RECEIPT_FILE');
  const runWorkspace = requiredEnv('PAPERCUSP_TEST_RUN_WORKSPACE');
  const runHarness = requiredEnv('PAPERCUSP_TEST_RUN_HARNESS');
  const sourceRef = requiredEnv('VERIFY_TAURI_SOURCE_REF');
  const sourceInputs = requiredEnv('VERIFY_TAURI_SOURCE_INPUTS').split(/[\s,]+/).filter(Boolean);
  const sourceReceiptPath = requiredEnv('VERIFY_TAURI_SOURCE_RECEIPT');

  expect(resolve(receiptPath), 'native acceptance evidence must use a separate file from reporter JSONL receipts')
    .not.toBe(resolve(reporterReceiptPath));
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  // verify-tauri-headless exports the verified post-boot seed as
  // VERIFY_TAURI_SEED; ISOLATED_SEED is only its input option.
  expect(process.env.VERIFY_TAURI_SEED).toBe('ready');
  expect(runWorkspace).toBe('papercusp-workspace');
  expect(runHarness).toBe('papercusp');
  expect(sourceRef).toMatch(/^[0-9a-f]{40,64}$/i);
  expect(sourceInputs).toContain('apps/operator/app/_components/inbox/use-inbox-pending.ts');
  expect(sourceInputs).toContain('apps/operator/app/admin/plans/plans-api.ts');
  expect(workspaceId).toMatch(/^verify-tauri-isolated-/);

  const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath, 'utf8')) as Record<string, unknown>;
  const run = promisify(execFile);
  const mcpCall = fileURLToPath(new URL('../../../scripts/mcp-call.mjs', import.meta.url));
  const evidence: Record<string, unknown> = {
    schemaVersion: 'native-inbox-ack-persistence-receipt-v1',
    startedAt: new Date().toISOString(),
    runGroup,
    runWorkspace,
    runHarness,
    papercuspWorkspaceId: workspaceId,
    sessionId,
    verifier: { pid, port, origin, sourceRef, sourceInputs, sourceReceipt },
  };
  let outcome: 'running' | 'passed' | 'failed' = 'running';

  await mkdir(dirname(receiptPath), { recursive: true });
  // Unique run-group paths are expected; fail before sending messages if a
  // caller accidentally points this acceptance at an existing receipt.
  await writeFile(receiptPath, JSON.stringify({ ...evidence, outcome }, null, 2) + '\n', { flag: 'wx' });

  async function invoke(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { stdout } = await run(process.execPath, [mcpCall, tool, JSON.stringify(args),
      '--client', sessionId, '--workspace', workspaceId, '--harness', 'papercusp', '--port', port], {
      cwd: process.cwd(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const result = decodeMcpOutput(stdout);
    if (result.ok === false) throw new Error(`${tool} returned ok:false: ${JSON.stringify(result)}`);
    return result;
  }

  async function native(command: string, ...args: string[]): Promise<unknown> {
    const { stdout } = await run(bridge, [command, '--pid', pid, ...args], {
      timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return decodeNativeBridgeJson(stdout);
  }

  const measure = (expression: string) => native('eval', `JSON.stringify(${expression})`);
  const feedArgs = { output: 'feed', harness: 'papercusp', limit: 200 };

  async function captureCache(label: string) {
    const stats = await invoke('dev:cache_stats', { tool: 'plans:attention' });
    const workspaceLiteral = `'${workspaceId.replaceAll("'", "''")}'`;
    const cacheRows = await invoke('dev:pg_query', {
      allowUnscoped: false,
      maxRows: 20,
      timeoutMs: 10_000,
      sql: `SELECT workspace_id, cache_key, tags, generation, expires_at, created_at FROM harness_shared.cache_l2 WHERE workspace_id = ${workspaceLiteral} AND cache_key LIKE 'plans:attention|%' ORDER BY cache_key`,
    });
    const rows = Array.isArray(cacheRows.rows) ? cacheRows.rows as Array<Record<string, unknown>> : [];
    const scoped = rows.filter((row) => row.workspace_id === workspaceId &&
      typeof row.cache_key === 'string' && row.cache_key.startsWith('plans:attention|'));
    evidence[label] = { stats, cacheRows };
    expect(scoped.length, `${label} must read this isolated workspace's plans:attention L2 row`).toBeGreaterThan(0);
    return { stats, rows: scoped };
  }

  try {
    const selectedSummary = `native Inbox acknowledgement ${runGroup} selected`;
    const neighborSummary = `native Inbox acknowledgement ${runGroup} neighbor`;
    const send = async (summary: string) => invoke('coord:send', {
      to: ['human'],
      summary,
      expects: 'none',
      body: [{ text: `Isolated native Inbox acceptance fixture ${runGroup}: ${summary}` }],
    });
    const selectedMessage = await send(selectedSummary);
    const neighborMessage = await send(neighborSummary);
    const selectedMsgId = sentMessageId(selectedMessage, 'selected fixture');
    const neighborMsgId = sentMessageId(neighborMessage, 'neighbor fixture');
    expect(selectedMsgId).toBeTruthy();
    expect(neighborMsgId).toBeTruthy();
    expect(neighborMsgId).not.toBe(selectedMsgId);
    evidence.messages = { selectedMsgId, neighborMsgId, selectedSummary, neighborSummary };

    const beforeAckFeed = await invoke('plans:attention', feedArgs);
    const selectedItem = findMessage(beforeAckFeed, selectedMsgId);
    const neighborItem = findMessage(beforeAckFeed, neighborMsgId);
    expect(selectedItem, 'the selected fixture must be present in the real attention feed').not.toBeNull();
    expect(neighborItem, 'the untouched neighbor must be present in the real attention feed').not.toBeNull();
    evidence.beforeAckFeed = { selectedItem, neighborItem };
    await captureCache('beforeAckCache');

    await native('navigate', `${origin}/adv?opcv=inbox`, '--json');
    await native('click', testIdSelector('inbox-filter-alerts'), '--json');
    const selectedRow = testIdSelector(`inbox-row-${selectedItem!.id}`);
    const neighborRow = testIdSelector(`inbox-row-${neighborItem!.id}`);
    await expect.poll(async () => {
      const state = await measure(`({ selected: !!document.querySelector(${JSON.stringify(selectedRow)}), neighbor: !!document.querySelector(${JSON.stringify(neighborRow)}) })`) as { selected: boolean; neighbor: boolean };
      return state.selected && state.neighbor;
    }, { timeout: 45_000, intervals: [300, 800, 1500] }).toBe(true);

    await native('click', selectedRow, '--json');
    const detail = testIdSelector(`inbox-expanded-${selectedItem!.id}`);
    await expect.poll(async () => measure(`(() => { const detail = document.querySelector(${JSON.stringify(detail)}); return !!detail && Array.from(detail.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Acknowledge'); })()`), {
      timeout: 30_000, intervals: [300, 800, 1500],
    }).toBe(true);

    const ackButtonId = 'native-inbox-ack-selected';
    const taggedAck = await measure(`(() => { const detail = document.querySelector(${JSON.stringify(detail)}); const button = Array.from(detail?.querySelectorAll('button') ?? []).find(candidate => candidate.textContent?.trim() === 'Acknowledge'); if (!button) return false; button.setAttribute('data-testid', ${JSON.stringify(ackButtonId)}); return true; })()`);
    expect(taggedAck).toBe(true);
    await native('click', testIdSelector(ackButtonId), '--json');

    const afterAckFeed = await invoke('plans:attention', feedArgs);
    const selectedAfterAck = findMessage(afterAckFeed, selectedMsgId);
    const neighborAfterAck = findMessage(afterAckFeed, neighborMsgId);
    evidence.afterAckFeed = { selectedItem: selectedAfterAck, neighborItem: neighborAfterAck };
    expect(selectedAfterAck, 'a fresh plans:attention read must omit the persisted acknowledgement').toBeNull();
    expect(neighborAfterAck, 'acknowledging one message must retain its unacknowledged neighbor').not.toBeNull();
    await captureCache('afterAckCache');

    await native('eval', 'window.__nativeInboxAckPreviousDocument = true; location.reload(); true');
    const postReloadSelector = `(() => { const selected = document.querySelector(${JSON.stringify(selectedRow)}); const neighbor = document.querySelector(${JSON.stringify(neighborRow)}); return { oldDocument: window.__nativeInboxAckPreviousDocument === true, ready: document.readyState === 'complete' && !!document.querySelector('[data-testid="inbox-master"]'), selected: !!selected, neighbor: !!neighbor }; })()`;
    await expect.poll(async () => measure(postReloadSelector), { timeout: 45_000, intervals: [500, 1000, 1500] }).toEqual({
      oldDocument: false, ready: true, selected: false, neighbor: true,
    });
    evidence.afterReload = await measure(postReloadSelector);
    await captureCache('afterReloadCache');
    outcome = 'passed';
  } catch (error) {
    outcome = 'failed';
    evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    try {
      evidence.failureState = await measure(`({ url: location.href, body: document.body.innerText.slice(0, 5000), selected: window.__nativeInboxAckSelected ?? null })`);
    } catch (diagnosticError) {
      evidence.failureStateError = String(diagnosticError);
    }
    throw error;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    evidence.outcome = outcome;
    await writeFile(receiptPath, JSON.stringify(evidence, null, 2) + '\n');
    await info.attach('native-inbox-ack-persistence-receipt', {
      path: receiptPath, contentType: 'application/json',
    });
  }
});
