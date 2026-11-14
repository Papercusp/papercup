/** Installed-client export observations. These reuse the native census fixtures'
 * private homes, loopback refusal and production OMP build. No provider calls. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { nativeBuilds } from '../../../../omp-plugin/build-native.mjs';
import { resolveOnPath, wellKnownBackendBin } from '../../backend-bin-resolve.mjs';
import { bootstrapDescriptionForClient, type FinalContextAttemptRecord,
  type FinalContextTranscriptLocator, type FinalContextNativeEmissionSource } from '../injection-delivery-coverage';
import { memoryFragmentOffer } from '../session-epoch-ledger';
import { ledgerDir, openDeliveryLedger, recordOmpMcpEmission } from '../../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import { codexCliResponsesBody } from '../../inference-gateway/codex-cli-bridge';
import { findCodexRolloutPathByUuid, findOmpSessionPath } from '../../session-transcript-resolvers';
import { findSessionTranscript } from '../../claude-sessions';

export type Descriptor = { name: string; description: string };
export type NativeExport = {
  client: 'codex' | 'claude' | 'omp'; clientVersion: string;
  evidencePlane: 'installed-client-local-request' | 'installed-client-registration' | 'installed-client-rpc-output'
    | 'installed-client-provider-context';
  descriptors: Descriptor[]; request: Record<string, unknown>; methods: string[];
  clientSettings: { toolSearch?: 'disabled'; descriptionMode?: 'full' | 'default'; maxMcpDescriptionChars?: number };
  stdoutDelivery?: { adapter: 'ptool-stdio' | 'omp-rpc'; owner: string; confirmations: object[] };
  stdoutReceipts?: Array<{ stage: string; owner: string; token: string; payloadSha256: string;
    payloadBytes: number; memoryFragments: object[] }>;
  stdoutEmissions?: FinalContextNativeEmissionSource[];
  diagnosticsPath: string;
  nativeTranscript?: { nativeSessionId: string; bindingEvidenceRef: string;
    originalPath: string; path: string; transcript: string; sourceSha256: string; sourceBytes: number };
};
export const baselineHash = '986f440eeaf59cf02a400fcd1caf206edae88cc7b04ccd95a91ba29235560ed4';
export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Locate exact tool-result text in retained, unmodified installed-client JSONL.
 * This supplies physical ordinals only; the production attribution validator
 * still checks source, session, call, timestamp and byte-range bindings. */
export function nativeMcpTranscriptLocators(capture: NativeExport,
  attempt: Pick<FinalContextAttemptRecord, 'sourceStoreId' | 'attemptId' | 'attemptSchemaVersion'>,
  visible: string): FinalContextTranscriptLocator[] {
  if (!capture.nativeTranscript) throw new Error('Physical native transcript missing');
  const records = capture.nativeTranscript.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
  const locators: FinalContextTranscriptLocator[] = [];
  for (const [recordIndex, record] of records.entries()) {
    const payload = capture.client === 'codex' && record.type === 'response_item' ? record.payload : record.message;
    if (!payload) continue;
    const content = capture.client === 'codex' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)
      ? payload.output : capture.client === 'claude' && record.type === 'user' ? payload.content
        : capture.client === 'omp' && record.type === 'message' && payload.role === 'toolResult' ? payload.content : [];
    if (!Array.isArray(content)) continue;
    for (const [contentIndex, block] of content.entries()) {
      const nested = capture.client === 'claude' && block.type === 'tool_result' && Array.isArray(block.content);
      const results = nested ? block.content : [block];
      for (const [resultContentIndex, result] of results.entries()) {
        const encoded = capture.client === 'codex' && payload.type === 'custom_tool_call_output' &&
          result.text === JSON.stringify({ content: [{ type: 'text', text: visible }] });
        if (result.text !== visible && !encoded) continue;
        locators.push({
        sourceStoreId: attempt.sourceStoreId, attemptId: attempt.attemptId,
        attemptSchemaVersion: attempt.attemptSchemaVersion, recordIndex, contentIndex,
        ...(nested ? { resultContentIndex } : {}),
        callId: capture.client === 'codex' ? payload.call_id
          : capture.client === 'claude' ? block.tool_use_id : payload.toolCallId,
        ...(encoded ? { encoding: 'codex-exec-mcp-json-v1' as const } : {}),
        startByte: 0, endByte: Buffer.byteLength(result.text) });
      }
    }
  }
  return locators;
}

/** Observe the transport action as well as its asynchronously delivered close
 * event. Cleanup can start between destroy() and that event without causing the
 * already-destroyed response to become a cleanup-induced close. */
export function observeNativeResponseClose(response: ServerResponse, cleaningUp: () => boolean) {
  const started = performance.now();
  const observation = { closed: false, destroyedBeforeCleanup: false,
    closedEventBeforeCleanup: false, closedBeforeCleanup: false,
    writableEnded: false, elapsedMs: null as number | null };
  const closed = new Promise<void>(resolve => response.once('close', () => {
    observation.closed = true;
    observation.closedEventBeforeCleanup = !cleaningUp();
    observation.closedBeforeCleanup = observation.destroyedBeforeCleanup || observation.closedEventBeforeCleanup;
    observation.writableEnded = response.writableEnded;
    observation.elapsedMs = performance.now() - started;
    resolve();
  }));
  return { observation, closed, destroy() {
    const beforeCleanup = !cleaningUp();
    const socket = response.socket;
    response.destroy();
    observation.destroyedBeforeCleanup = beforeCleanup && response.destroyed && socket?.destroyed === true;
    if (observation.closed && observation.destroyedBeforeCleanup) observation.closedBeforeCleanup = true;
  } };
}

export function frozenBootstrap() {
  const bytes = readFileSync(new URL('./r7-native-pre-change.json', import.meta.url));
  if (sha256(bytes) !== baselineHash) throw new Error('native baseline hash mismatch');
  const baseline = JSON.parse(bytes.toString('utf8')) as { tools: Descriptor[] };
  let prefix = baseline.tools[0]!.description;
  for (const tool of baseline.tools.slice(1)) {
    let index = 0;
    while (index < prefix.length && prefix[index] === tool.description[index]) index++;
    prefix = prefix.slice(0, index);
  }
  if (prefix.length !== 19367 || baseline.tools.length !== 55) throw new Error('native baseline population mismatch');
  return { baseline, prefix, contracts: baseline.tools.map(tool => ({ ...tool,
    description: tool.description.slice(prefix.length) })) };
}

export function requestDescriptors(value: unknown): Descriptor[] {
  if (Array.isArray(value)) return value.flatMap(requestDescriptors);
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  // Native clients can name and describe a namespace which contains the actual
  // function declarations. Keep walking after recording that wrapper.
  const own = typeof row.name === 'string' && typeof row.description === 'string'
    ? [{ name: row.name, description: row.description }] : [];
  return [...own, ...Object.values(row).flatMap(requestDescriptors)];
}

/** Reuse the maintained native sandbox's local Responses/Messages exchange.
 * The installed client executes its advertised tool; no inference is sent. */
function sendReceiptTurn(res: ServerResponse, client: 'codex' | 'claude',
  request: Record<string, unknown>, toolName: string, done: boolean, callId = 'receipt_call'): void {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  if (client === 'claude') {
    const name = requestDescriptors(request.tools).find(tool => tool.name.endsWith(toolName))?.name;
    if (!done && !name) throw new Error('Native Claude receipt tool absent from request');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event('message_start', { message: { id: 'msg_receipt', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 } } })
      + event('content_block_start', { index: 0, content_block: done
        ? { type: 'text', text: '' } : { type: 'tool_use', id: callId, name, input: {} } })
      + event('content_block_delta', { index: 0, delta: done
        ? { type: 'text_delta', text: 'Receipt observed.' } : { type: 'input_json_delta', partial_json: '{}' } })
      + event('content_block_stop', { index: 0 })
      + event('message_delta', { delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 } }) + event('message_stop', {}));
    return;
  }
  const tools = [...(Array.isArray(request.tools) ? request.tools : []),
    ...(Array.isArray(request.input) ? request.input.flatMap(item => Array.isArray(item.tools) ? item.tools : []) : [])] as Array<Record<string, unknown>>;
  const namespace = tools.find(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    && tool.tools.some(child => child.name === toolName));
  const direct = tools.find(tool => tool.type === 'function' && typeof tool.name === 'string'
    && tool.name.endsWith(toolName));
  const executorNamespace = tools.find(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
    && tool.tools.some(child => child.type === 'custom' && child.name === 'exec'));
  const executor = executorNamespace ?? tools.find(tool => tool.type === 'custom' && tool.name === 'exec');
  if (!done && !namespace && !direct && !executor) throw new Error('Native Codex receipt tool absent from request');
  const item = done
    ? { id: 'receipt_done', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Receipt observed.', annotations: [] }] }
    : executor ? { id: `${callId}_exec`, type: 'custom_tool_call', call_id: callId,
      ...(executorNamespace ? { namespace: executorNamespace.name } : {}), name: 'exec', status: 'completed', input:
        `const tool = ALL_TOOLS.find(row => row.name.endsWith(${JSON.stringify(toolName)}));
if (!tool) throw new Error('Receipt tool absent from native catalog');
text(await tools[tool.name]({}));` }
      : { id: `${callId}_function`, type: 'function_call', call_id: callId,
        ...(namespace ? { namespace: namespace.name } : {}), name: direct?.name ?? toolName,
        arguments: '{}', status: 'completed' };
  const response = { ...codexCliResponsesBody({ model: 'gpt-6.1-sol', text: '', inputTokens: 1, outputTokens: 1 }),
    output: [item] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress',
    ...(!done ? executor ? { input: '' } : { arguments: '' } : {}) } })
    + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response }));
}

/** A real pipe consumer between the installed host and the unchanged ptool.
 * Stop reading during the large receipt response, before Node can complete its
 * stdout callback. Retain the request, consumed prefix and child close evidence;
 * a killed host or an absent provider request alone cannot pass this probe. */
function partialReceiptPipe(bridgeArgs: string[], port: string, probePath: string): string {
  return String.raw`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ${JSON.stringify(bridgeArgs)}, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const probe = { targetMethod: ${JSON.stringify(port === 'initialize' ? 'initialize' : 'tools/call')},
  pid: child.pid, targetRequest: null, consumedBytes: 0, forwardedBytes: 0, prefix: '',
  cut: false, closed: false, stderr: '', exitCode: null, signal: null };
const save = () => writeFileSync(${JSON.stringify(probePath)}, JSON.stringify(probe), { mode: 0o600 });
let input = '', cleanup;
process.stdin.on('data', chunk => {
  input += chunk.toString('utf8');
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (line.trim()) {
      const request = JSON.parse(line);
      if (request.method === probe.targetMethod) probe.targetRequest = request;
    }
  }
  if (!child.stdin.destroyed) child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
process.stdout.on('error', () => child.kill('SIGKILL'));
child.stderr.on('data', chunk => { probe.stderr = (probe.stderr + chunk).slice(-6000); });
child.stdout.on('data', chunk => {
  if (probe.targetRequest && !probe.cut) {
    probe.consumedBytes = chunk.length;
    const prefix = chunk.subarray(0, 1024);
    probe.forwardedBytes = prefix.length;
    probe.prefix = prefix.toString('utf8');
    probe.cut = true;
    process.stdout.write(prefix);
    child.stdout.destroy();
    child.stdin.end();
    save();
    // Cleanup is separate from the measured OS read-end close above.
    cleanup = setTimeout(() => child.kill('SIGKILL'), 500);
  } else if (!probe.cut) process.stdout.write(chunk);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGKILL'));
child.on('error', error => { probe.stderr += String(error); save(); process.exitCode = 1; });
child.on('close', (code, signal) => {
  clearTimeout(cleanup);
  probe.closed = true; probe.exitCode = code; probe.signal = signal;
  save(); process.stdout.end();
});
save();`;
}

/** Byte observer for the existing ptool pipe; does not author receipts or
 * rewrite JSON-RPC ids. Both sides survive private-home cleanup. */
function retainedReceiptPipe(bridgeArgs: string[], wirePath: string): string {
  return String.raw`import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(process.execPath, ${JSON.stringify(bridgeArgs)}, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const buffers = { request: '', response: '' };
const observe = (direction, chunk) => {
  buffers[direction] += chunk.toString('utf8');
  let newline;
  while ((newline = buffers[direction].indexOf('\n')) >= 0) {
    const payload = buffers[direction].slice(0, newline + 1);
    buffers[direction] = buffers[direction].slice(newline + 1);
    appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ direction, payload }) + '\n', { mode: 0o600 });
  }
};
process.stdin.on('data', chunk => { observe('request', chunk); child.stdin.write(chunk); });
process.stdin.on('end', () => child.stdin.end());
child.stdin.on('error', () => {});
child.stdout.on('data', chunk => { observe('response', chunk); process.stdout.write(chunk); });
child.stderr.pipe(process.stderr);
process.stdout.on('error', () => child.kill('SIGKILL'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; process.stdout.end(); });`;
}

export async function captureNativeMcp(client: NativeExport['client'], tools: Descriptor[],
  instructions?: string, denied: string[] = [],
  options: { claudeDescriptionMode?: 'full' | 'default'; stdioReceipt?: 'memory' | 'corpus';
    codexCodeMode?: boolean;
    ompProviderContext?: 'complete' | 'remove-instructions';
    receiptAdapter?: 'ptool-stdio' | 'omp-rpc';
    stdioPort?: 'initialize' | 'orient' | 'claim' | 'create'; maxProviderExchanges?: number;
    stdioFault?: 'absent-offer' | 'partial-stdout' | 'lost-response' | 'deadline';
    stdioOwner?: string;
    // Exercise the next native MCP call that carries the immutable stdout
    // confirmation back to a production backend supplied by mcpResult.
    stdioConfirm?: boolean;
    // Physical client JSONL is separate from provider requests and receipts.
    retainNativeTranscript?: boolean;
    // Let a backend integration supply the production response/offer while
    // retaining this fixture's installed client and real stdout boundary.
    mcpResult?: (method: string, result: Record<string, unknown>, request: Record<string, unknown>,
      // OMP's observed RPC state or Claude's explicit launch --session-id;
      // retained final native output must independently confirm either one.
      nativeSessionId: string | null) => Promise<Record<string, unknown>>;
    onDiagnostics?: (path: string) => void } = {}): Promise<NativeExport> {
  // The explicit profile executes the production in-process OMP adapter and
  // observes final RPC stdout. Registration alone remains a separate census.
  const ompReceipt = options.receiptAdapter === 'omp-rpc';
  const providerContext = options.ompProviderContext;
  if (providerContext && (client !== 'omp' || options.stdioReceipt || !instructions))
    throw new Error('OMP provider context observation requires initialized instructions without a receipt profile');
  const receiptAdapter = options.receiptAdapter ?? 'ptool-stdio';
  if (ompReceipt && (client !== 'omp' || !options.stdioReceipt || !instructions
      || !options.stdioPort || options.stdioPort === 'initialize'))
    throw new Error('OMP RPC receipt profile requires an OMP tool-result port');
  if (options.stdioReceipt && ((!ompReceipt && client === 'omp') || !instructions))
    throw new Error('Native stdout receipt profile requires Codex/Claude instructions');
  if (options.stdioFault && !options.stdioReceipt)
    throw new Error('Native stdout fault requires a receipt profile');
  const binary = wellKnownBackendBin(client === 'claude' ? 'claude-code' : client) ?? resolveOnPath(client);
  if (!binary) throw new Error(`Installed ${client} is required for native export evidence`);
  const maxProviderExchanges = options.maxProviderExchanges ?? 8;
  if (!Number.isInteger(maxProviderExchanges) || maxProviderExchanges < 1 || maxProviderExchanges > 32)
    throw new Error('Native provider exchange limit must be an integer from 1 to 32');
  let clientVersion = 'UNKNOWN';
  const clientSettings: NativeExport['clientSettings'] = {};
  const home = mkdtempSync(join(tmpdir(), `${client}-mcp-wire-`));
  // Version launchers can execute Node preloads before reaching the native
  // binary. Give both probes the same private, allowlisted environment;
  // inheriting Vitest loaders here defeats the client isolation below.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home };
  const versionProbe = { timeoutMs: 5000, elapsedMs: null as number | null,
    environmentScope: 'private-client-home', inheritedNodeOptions: env.NODE_OPTIONS !== undefined };
  // This sibling survives private-home cleanup, including a failing exchange.
  const diagnosticsPath = `${home}.diagnostics.json`;
  const pipeProbePath = `${home}.pipe.json`;
  const providerContextPath = join(home, 'provider-context.json');
  const receiptOwner = options.stdioOwner ?? `su-native-receipt-${client}`;
  const receiptPort = options.stdioPort ?? 'initialize';
  const receiptOffer = options.stdioReceipt ? { owner: receiptOwner, token: `native-${receiptPort}-${client}`,
    fragments: [memoryFragmentOffer(options.stdioReceipt, `native-${options.stdioReceipt}`, 3, receiptPort, instructions!)] } : null;
  const callReceipt = !!receiptOffer && receiptPort !== 'initialize';
  if (options.retainNativeTranscript && (!callReceipt || options.stdioFault))
    throw new Error('Native transcript capture requires a complete tool-result receipt profile');
  if (options.stdioConfirm && !callReceipt)
    throw new Error('Native confirmation requires a tool-result receipt profile');
  const responseOffer = options.stdioFault === 'absent-offer' ? null : receiptOffer;
  const methods: string[] = [], captures: Record<string, unknown>[] = [];
  const mcpRequests: Record<string, unknown>[] = [];
  const providerRoutes: string[] = [];
  const rpcOutputs: Array<{ payload: string; payloadSha256: string; payloadBytes: number; recorded: boolean }> = [];
  const stdoutEmissions: FinalContextNativeEmissionSource[] = [];
  const stdioWirePath = `${home}.stdio.jsonl`;
  let nativeSessionId: string | undefined;
  let nativeSessionState: Record<string, unknown> | undefined;
  let nativeTranscript: NativeExport['nativeTranscript'];
  const requestedClaudeSessionId = options.retainNativeTranscript && client === 'claude' ? randomUUID() : undefined;
  let failure: string | null = null;
  let invocation: { argv: string[]; environment: Record<string, string | null> } | null = null;
  let child: ReturnType<typeof spawn> | undefined, stderr = '', stdout = '';
  let cleanupStarted = false;
  const transportFaults: Array<{ method: string; requestId: unknown; fault: string;
    preparedToken: string; closedBeforeCleanup: boolean; writableEnded: boolean; elapsedMs: number | null;
    cancelledByClient: boolean; cancellationReason: string | null }> = [];
  const pendingFaultResponses = new Map<unknown, ReturnType<typeof observeNativeResponseClose>>();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
        res.end('{"models":[]}'); return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const route = new URL(req.url ?? '/', 'http://offline.invalid').pathname;
      if (route === '/mcp' || route === '/api/mcp') {
        mcpRequests.push(body);
        const method = String(body.method); methods.push(method);
        if (body.id === undefined) {
          // A real SDK cancellation terminates the matching pending fixture
          // operation. Socket close alone cannot establish who cancelled it.
          if (method === 'notifications/cancelled') {
            const params = body.params as { requestId?: unknown; reason?: unknown } | undefined;
            const fault = transportFaults.find(row => row.requestId === params?.requestId && row.fault === 'deadline');
            if (fault) {
              fault.cancelledByClient = true;
              fault.cancellationReason = String(params?.reason);
              pendingFaultResponses.get(params?.requestId)?.destroy();
            }
          }
          res.writeHead(202); res.end(); return;
        }
        const result = method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
            // Call-port canaries must first appear in the tool response;
            // initialization would contaminate the partial-output oracle.
            serverInfo: { name: 'offline-canary', version: '1' }, ...(instructions && !callReceipt ? { instructions } : {}),
            ...(responseOffer && !callReceipt ? { _meta: { 'papercusp/memoryEmission': responseOffer } } : {}) }
          : method === 'tools/list' ? { tools: [...tools,
            ...(ompReceipt ? [{ name: 'receipt_confirmation', description: 'Confirm the previous local output.' }] : [])].map(tool => ({ ...tool,
            inputSchema: { type: 'object', properties: {} },
            // This canary only returns a fixed local observation. Leaving its
            // safety unspecified makes Codex require interactive approval.
            ...(receiptOffer ? { annotations: { readOnlyHint: true, destructiveHint: false,
              idempotentHint: true, openWorldHint: false } } : {}),
            ...(receiptOffer ? { _meta: { 'papercusp/servingGeneration': 'native-receipt-fixture-v1' } } : {}) })) }
            : method === 'tools/call' && callReceipt && (body.params as { name?: string })?.name !== 'receipt_confirmation' ? {
              content: [{ type: 'text', text: JSON.stringify({ [receiptPort]: instructions }) }],
              ...(responseOffer ? { _meta: { 'papercusp/memoryEmission': responseOffer } } : {}) }
              : ompReceipt && method === 'tools/call' ? { content: [{ type: 'text', text: 'Confirmed.' }] } : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        const emitted: Record<string, unknown> = options.mcpResult
          ? await options.mcpResult(method, result, body, nativeSessionId ?? requestedClaudeSessionId ?? null) : result;
        if ((options.stdioFault === 'lost-response' || options.stdioFault === 'deadline')
          && method === (receiptPort === 'initialize' ? 'initialize' : 'tools/call')
          && (body.params as { name?: string })?.name !== 'receipt_confirmation') {
          const offer = (emitted._meta as Record<string, unknown> | undefined)?.['papercusp/memoryEmission'] as
            { token?: string } | undefined;
          if (!offer?.token) throw new Error('Native transport fault requires an actual prepared emission offer');
          const closure = observeNativeResponseClose(res, () => cleanupStarted);
          const observation = Object.assign(closure.observation, { method, requestId: body.id, fault: options.stdioFault,
            preparedToken: offer.token, cancelledByClient: false, cancellationReason: null as string | null });
          transportFaults.push(observation);
          pendingFaultResponses.set(body.id, closure);
          void closure.closed.then(() => pendingFaultResponses.delete(body.id));
          if (options.stdioFault === 'lost-response') closure.destroy();
          // Deadline leaves the actual HTTP response pending. Only the native
          // client's deadline/cancellation may close it before fixture cleanup.
          return;
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: emitted })); return;
      }
      if (callReceipt && req.url?.includes('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 })); return;
      }
      if (req.url?.includes('/responses') || Array.isArray(body.tools)) {
        captures.push(body);
        providerRoutes.push(route);
        if (captures.length > maxProviderExchanges) {
          failure = `Native provider exchange limit exceeded (${maxProviderExchanges})`;
          child?.kill('SIGKILL');
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: failure })); return;
        }
        if (callReceipt && client !== 'omp') {
          const calls = mcpRequests.filter(request => request.method === 'tools/call').length;
          const confirming = options.stdioConfirm && calls === 1;
          // The stdio bridge advertises its one selected tool. Reuse that
          // actual declaration for the next call carrying the receipt.
          sendReceiptTurn(res, client, body, tools[0]!.name,
            calls >= (options.stdioConfirm ? 2 : 1), confirming ? 'receipt_confirmation_call' : 'receipt_call');
          return;
        }
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Offline capture complete; no forwarding."}}');
    } catch (error) {
      // Keep a backend assertion as the failure, rather than losing it behind
      // an installed client's generic invalid-response or timeout message.
      failure ??= String(error);
      if (!res.headersSent) res.writeHead(400);
      res.end(String(error));
    }
  });
  const frameTypes: string[] = [];
  try {
    const versionStarted = performance.now();
    try {
      clientVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: versionProbe.timeoutMs,
        env, cwd: home }).trim();
    } finally { versionProbe.elapsedMs = performance.now() - versionStarted; }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bridgeArgs = [fileURLToPath(new URL('../../../../../apps/operator/scripts/ptool.mjs', import.meta.url)),
      tools[0]!.name, '--stdio', '--transport', 'http', '--url', baseURL, '--token-file', join(home, 'mcp-token')];
    let nativeBridgeArgs = bridgeArgs;
    if (options.retainNativeTranscript && (client === 'claude' || client === 'codex')) {
      const wrapper = join(home, 'retained-receipt-pipe.mjs');
      writeFileSync(wrapper, retainedReceiptPipe(bridgeArgs, stdioWirePath));
      nativeBridgeArgs = [wrapper];
      // The same explicit id is passed to --session-id and verified against
      // the actual result/native JSONL below, as in managed Claude launches.
      if (client === 'claude') env.PAPERCUSP_NATIVE_SESSION_ID = requestedClaudeSessionId!;
    }
    if (options.stdioFault === 'partial-stdout' && !ompReceipt) {
      const wrapper = join(home, 'partial-receipt-pipe.mjs');
      writeFileSync(wrapper, partialReceiptPipe(bridgeArgs, receiptPort, pipeProbePath));
      nativeBridgeArgs = [wrapper];
    }
    if (receiptOffer) {
      writeFileSync(join(home, 'mcp-token'), 'offline-fixture-only', { mode: 0o600 });
      Object.assign(env, { PAPERCUSP_HOME: home, PAPERCUSP_OPERATOR_HOME: home,
        PAPERCUSP_SID: receiptOwner, PAPERCUSP_AGENT: client,
        // The canonical test runner owns this ancestor reader lease. Preserve
        // it in the nested ptool child; never fabricate a lease for a new root.
        ...(process.env.PAPERCUSP_INSTALL_MUTEX_HELD
          ? { PAPERCUSP_INSTALL_MUTEX_HELD: process.env.PAPERCUSP_INSTALL_MUTEX_HELD } : {}) });
    }
    let argv: string[];
    const registrationPath = join(home, 'registrations.json');
    if (client === 'codex') {
      const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_capture_token_'.repeat(3) } });
      writeFileSync(join(home, 'config.toml'), ['model = "gpt-6.1-sol"', ...gateway.root, ...gateway.tables,
        ...(options.codexCodeMode ? ['[features]', 'code_mode = true', 'code_mode_only = true'] : []),
        '[mcp_servers.offline_canary]', ...(receiptOffer
          ? [`command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify(nativeBridgeArgs)}`,
            // Codex filters the MCP child's inherited environment. These are
            // fixture identities and private paths, never account credentials.
            `env = { ${['PAPERCUSP_HOME', 'PAPERCUSP_OPERATOR_HOME', 'PAPERCUSP_SID',
              'PAPERCUSP_AGENT', 'PAPERCUSP_INSTALL_MUTEX_HELD'].filter(key => env[key])
              .map(key => `${key} = ${JSON.stringify(env[key])}`).join(', ')} }`]
          : [`url = "${baseURL}/mcp"`]), 'required = true',
        'startup_timeout_sec = 10', 'tool_timeout_sec = 10'].join('\n'));
      Object.assign(env, { CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' });
      argv = ['exec', '--skip-git-repo-check', ...(options.retainNativeTranscript ? [] : ['--ephemeral']), '--json', '-C', home,
        ...(callReceipt ? ['--config', 'approval_policy="never"'] : []),
        callReceipt ? `Offline fixture: call ${tools[0]!.name} once then reply OK.` : 'Offline fixture: reply OK. Do not use tools.'];
    } else if (client === 'claude') {
      const path = join(home, 'mcp.json');
      writeFileSync(path, JSON.stringify({ mcpServers: { offline_canary: receiptOffer
        ? { type: 'stdio', command: process.execPath, args: nativeBridgeArgs }
        : { type: 'http', url: `${baseURL}/mcp` } } }));
      const descriptionMode = options.claudeDescriptionMode ?? 'full';
      Object.assign(clientSettings, { toolSearch: 'disabled', descriptionMode });
      if (descriptionMode === 'full') {
        // Compare complete schemas with a fixed ceiling derived from the
        // immutable baseline in BOTH arms. Claude's default description cap
        // is a different observation, retained by its own native canary.
        // The client expands ellipses BEFORE applying its character ceiling.
        // Sizing from raw input can truncate the longest frozen declaration.
        clientSettings.maxMcpDescriptionChars = Math.max(1,
          ...frozenBootstrap().baseline.tools.map(tool => bootstrapDescriptionForClient(client, tool.description).length),
          ...tools.map(tool => bootstrapDescriptionForClient(client, tool.description).length),
          bootstrapDescriptionForClient(client, instructions ?? '').length);
        env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(clientSettings.maxMcpDescriptionChars);
      }
      Object.assign(env, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: baseURL,
        ANTHROPIC_API_KEY: 'offline-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        ...(options.stdioFault === 'deadline' ? { MCP_TIMEOUT: '10000', MCP_CONNECT_TIMEOUT_MS: '10000',
          MCP_TOOL_TIMEOUT: '10000' } : {}),
        // This paired full-schema profile does not establish parity with
        // default deferred ToolSearch or default description truncation.
        ENABLE_TOOL_SEARCH: 'false' });
      argv = ['--print', '--output-format', 'json', '--model', 'claude-haiku-4-5',
        ...(requestedClaudeSessionId ? ['--session-id', requestedClaudeSessionId] : ['--no-session-persistence']),
        '--setting-sources', '', '--strict-mcp-config', `--mcp-config=${path}`,
        ...(callReceipt ? [`--allowedTools=mcp__offline_canary__${tools[0]!.name}`] : []),
        ...(denied.length ? [`--disallowedTools=${denied.join(',')}`] : []), '--', 'Offline fixture: reply OK.'];
    } else {
      // A fresh HOME makes the compiled OMP extract its large native addon
      // before emitting any RPC frame. Reuse ONLY the installed version's
      // libraries in our private home; never copy settings or credentials.
      const version = /^omp\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(clientVersion)?.[1];
      if (!version) throw new Error(`Unrecognized installed OMP version: ${clientVersion}`);
      const cacheRoots = [join(homedir(), '.omp', 'natives'),
        ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, 'omp', 'natives')] : [])];
      const cached = cacheRoots.map(root => join(root, version)).find(existsSync);
      const libraries = cached ? readdirSync(cached, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.node')) : [];
      if (!cached || !libraries.length) throw new Error(`Installed OMP ${version} native libraries are not prepared`);
      const privateCache = join(home, '.omp', 'natives', version);
      mkdirSync(privateCache, { recursive: true });
      for (const entry of libraries) copyFileSync(join(cached, entry.name), join(privateCache, entry.name), constants.COPYFILE_FICLONE);
      const checkout = fileURLToPath(new URL('../../../../../', import.meta.url));
      const recipe = nativeBuilds(checkout, `${home}/`).find(value => value.format === 'esm');
      if (!recipe) throw new Error('owned OMP build recipe missing');
      await build(recipe);
      const extension = join(home, 'capture.ts');
      // Observe exactly what the production adapter registers in the installed
      // OMP API, then delegate unchanged. dumpTools omits deferred MCP schemas.
      writeFileSync(extension, `import { writeFileSync } from 'node:fs';
import { registerNativeMcp } from './native-extension.mjs';
export default async function(pi) {
  let turn = 0;
  pi.registerProvider('native-export-fixture', {
    api: 'native-export-fixture-api', apiKey: 'local-only', baseUrl: 'http://unused.invalid',
    models: [{ id: 'proof', name: 'Local export proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      if (!${ompReceipt || !!providerContext}) throw new Error('Export census must not request inference');
      if (${!!providerContext}) writeFileSync(${JSON.stringify(providerContextPath)}, JSON.stringify({
        systemPrompt: context.systemPrompt, messages: context.messages,
      }));
      if (++turn > 4) throw new Error('Unexpected native receipt inference turn');
      const tool = ${ompReceipt} && turn === 1 ? ${JSON.stringify(tools[0]!.name)}
        : ${ompReceipt} && turn === 3 ? 'receipt_confirmation' : null;
      const content = tool ? [{ type: 'toolCall', id: 'receipt-call-' + turn,
        name: 'mcp__papercusp_su_' + tool, arguments: {} }] : [{ type: 'text', text: 'Complete' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: message };
        if (tool) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
        yield { type: 'done', reason: message.stopReason, message };
      }, result: async () => message };
    }
  });
  const rows = [];
  await registerNativeMcp({ on: pi.on.bind(pi), registerTool(tool) {
    rows.push({ name: tool.name, description: tool.description });
    // Inject the fault through the installed native callback's real signal.
    // OMP's production SDK default is 60s; the fixture owns a bounded 10s
    // deadline without adding a runtime setting or changing that default.
    if (${options.stdioFault === 'deadline'}) {
      const execute = tool.execute;
      tool = { ...tool, execute(id, params, signal, ...rest) {
        return execute(id, params, AbortSignal.any([
          ...(signal ? [signal] : []), AbortSignal.timeout(10_000),
        ]), ...rest);
      } };
    }
    pi.registerTool(tool);
  } }, { papercuspNativeMcp: { version: 1, mode: 'http', servers: {
    ${ompReceipt ? "'papercusp-su'" : 'offline_canary'}: { url: ${JSON.stringify(`${baseURL}/mcp`)},
      ${ompReceipt ? `headers: { 'x-papercusp-client': ${JSON.stringify(receiptOwner)} }` : ''} }
  } } });
  ${providerContext === 'remove-instructions' ? "pi.on('before_agent_start', () => ({ systemPrompt: ['Replaced by a later native extension'] }));" : ''}
  writeFileSync(${JSON.stringify(registrationPath)}, JSON.stringify(rows));
}`);
      Object.assign(env, { PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions'),
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') });
      argv = ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-rules',
        ...(options.retainNativeTranscript ? ['--session-dir', join(home, 'sessions', 'fixture')] : ['--no-session']),
        '--extension', extension, '--model', 'native-export-fixture/proof'];
    }
    invocation = { argv, environment: Object.fromEntries([
      'HOME', 'CODEX_HOME', 'PAPERCUSP_HOME', 'PAPERCUSP_OPERATOR_HOME', 'PAPERCUSP_SID',
      'PAPERCUSP_AGENT', 'PAPERCUSP_INSTALL_MUTEX_HELD',
      'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
      'MCP_TIMEOUT', 'MCP_CONNECT_TIMEOUT_MS', 'MCP_TOOL_TIMEOUT',
    ].map(key => [key, env[key] ?? null])) };
    child = spawn(binary, argv, { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
    const running = child;
    if (client === 'omp') {
      let buffer = Buffer.alloc(0), requested = false, endedTurns = 0, cut = false;
      running.stdout!.on('data', (chunk: Buffer) => {
        if (cut) return;
        stdout = (stdout + chunk.toString('utf8')).slice(-3000);
        buffer = Buffer.concat([buffer, chunk]);
        let newline: number;
        while (buffer.length) {
          // Close the actual native stdout read end after a nonempty prefix,
          // before passing any incomplete frame to the production instrument.
          if (ompReceipt && options.stdioFault === 'partial-stdout' && buffer.length >= 1024
              && buffer.subarray(0, 150).toString('utf8').includes('"type":"tool_execution_end"')) {
            const prefix = buffer.subarray(0, 1024).toString('utf8');
            const probe = { cut: true, closed: false, forwardedBytes: 1024, consumedBytes: buffer.length, prefix,
              targetMethod: 'tools/call', targetRequest: mcpRequests.find(row => row.method === 'tools/call'),
              recorded: recordOmpMcpEmission(prefix, receiptOwner, nativeSessionId, env) };
            writeFileSync(pipeProbePath, JSON.stringify(probe));
            cut = true;
            running.stdout!.destroy(); running.stdin!.end();
            running.once('close', () => writeFileSync(pipeProbePath, JSON.stringify({ ...probe, closed: true })));
            running.kill('SIGTERM');
            break;
          }
          newline = buffer.indexOf(10);
          if (newline < 0) break;
          const bytes = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
          const line = bytes.toString('utf8');
          if (!line.trim()) continue;
          let frame: Record<string, unknown>;
          try {
            if (!Buffer.from(line).equals(bytes)) throw new Error('Native RPC UTF-8 round trip failed');
            frame = JSON.parse(line);
          } catch (error) { failure = String(error); running.kill('SIGKILL'); break; }
          frameTypes.push(String(frame.type));
          if (frame.type === 'ready' && !requested) {
            requested = true; running.stdin!.write(JSON.stringify({ id: 'export', type: 'get_state' }) + '\n');
          }
          if (frame.type === 'response' && frame.id === 'export') {
            if (!ompReceipt && !providerContext) { captures.push(frame); running.kill('SIGTERM'); }
            else {
              nativeSessionState = frame.data as Record<string, unknown>;
              nativeSessionId = (frame.data as { sessionId?: string })?.sessionId;
              if (frame.success !== true || !nativeSessionId) {
                failure = 'Native OMP receipt session is unbound'; running.kill('SIGKILL'); break;
              }
              running.stdin!.write(JSON.stringify({ id: 'receipt', type: 'prompt', message: 'Run the local receipt call.' }) + '\n');
            }
          }
          if (ompReceipt && nativeSessionId && frame.type === 'tool_execution_end') {
            const recorded = recordOmpMcpEmission(line, receiptOwner, nativeSessionId, env);
            rpcOutputs.push({ payload: line, payloadSha256: sha256(bytes), payloadBytes: bytes.length, recorded });
            if (!captures.length) captures.push(frame);
          }
          if (ompReceipt && frame.type === 'agent_end') {
            if (++endedTurns === 1) running.stdin!.write(JSON.stringify({ id: 'confirmation', type: 'prompt',
              message: 'Confirm the previous local output.' }) + '\n');
            else running.kill('SIGTERM');
          }
          if (providerContext && frame.type === 'agent_end') {
            try { captures.push(JSON.parse(readFileSync(providerContextPath, 'utf8'))); }
            catch { failure = 'Native OMP provider context was not observed'; }
            running.kill('SIGTERM');
          }
        }
      });
    } else {
      // Codex treats a live stdin as additional input even with a prompt argv.
      // The original native fixture used stdio:'ignore'; preserve that EOF.
      running.stdin!.end();
      running.stdout!.setEncoding('utf8');
      let nativeFrames = '';
      running.stdout!.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-16000);
        if (!options.retainNativeTranscript) return;
        nativeFrames += chunk;
        let newline: number;
        while ((newline = nativeFrames.indexOf('\n')) >= 0) {
          const line = nativeFrames.slice(0, newline); nativeFrames = nativeFrames.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line);
            const id = client === 'codex' && frame.type === 'thread.started' ? frame.thread_id
              : client === 'claude' && frame.type === 'result' ? frame.session_id : undefined;
            if (id !== undefined) {
              if (typeof id !== 'string' || !id || (nativeSessionId && nativeSessionId !== id)
                  || (requestedClaudeSessionId && requestedClaudeSessionId !== id))
                throw new Error('Native stdout session binding mismatch');
              nativeSessionId = id;
            }
          } catch (error) { failure ??= String(error); }
        }
      });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        running.kill('SIGKILL');
        reject(new Error(`${client} native export timed out: ${JSON.stringify({
          methods, frameTypes, captures: captures.length, stdout, stderr,
        })}`));
      }, 25_000);
      running.once('error', error => { clearTimeout(timer); reject(error); });
      running.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (failure) throw new Error(failure);
    if (running.exitCode !== 0 && !captures.length)
      throw new Error(`${client} native export exited without a provider request: ${stderr}`);
    if (!methods.includes('initialize') || !methods.includes('tools/list')) throw new Error(`${client} MCP handshake missing: ${stderr}`);
    const request = callReceipt ? captures.at(-1)
      : captures.find(body => client === 'omp' || JSON.stringify(body).includes(tools[0]!.name));
    if (!request) throw new Error(`${client} native export missing: ${stderr}`);
    const descriptors = client === 'omp' ? JSON.parse(readFileSync(registrationPath, 'utf8')) as Descriptor[]
      : requestDescriptors(request.tools);
    if (client === 'omp' && !ompReceipt && !providerContext) {
      const data = request.data as Record<string, unknown>;
      const prompt = (data.systemPrompt as string[]).join('\n');
      if (request.success !== true || !prompt.includes('xd://mcp__offline_canary_')) throw new Error('OMP mounted route missing');
    }
    const confirmations = receiptOffer
      ? openDeliveryLedger(receiptOwner, env, 'mcp')?.confirmedMemoryDeliveries() ?? [] : [];
    // Retain the production instrument's immutable exact-byte receipt before
    // the private client home is removed. Provider input alone is not a
    // replacement for the stdout terminal event.
    const stdoutReceipts: NativeExport['stdoutReceipts'] = confirmations.map(proof => {
      const { token } = proof as { token: string };
      const receiptJson = readFileSync(join(ledgerDir(env), `${receiptOwner}.mcp.emissions`, `${sha256(token)}.json`), 'utf8');
      const receipt = JSON.parse(receiptJson);
      if (options.retainNativeTranscript && ompReceipt) {
        const outputs = rpcOutputs.filter(output => output.recorded && output.payloadSha256 === receipt.payloadSha256);
        if (outputs.length !== 1) throw new Error('Exact native RPC stdout payload missing or ambiguous');
        stdoutEmissions.push({ receiptJson, receiptSha256: sha256(receiptJson), payload: outputs[0]!.payload,
          evidenceRef: diagnosticsPath + '#stdoutEmissions/token=' + token });
      }
      if (options.retainNativeTranscript && (client === 'claude' || client === 'codex')) {
        const wire: Array<{ direction: string; payload: string }> = readFileSync(stdioWirePath, 'utf8').trimEnd().split('\n')
          .map(line => JSON.parse(line));
        const responses = wire.filter(row => row.direction === 'response' && sha256(row.payload) === receipt.payloadSha256);
        if (responses.length !== 1) throw new Error('Exact native stdio stdout payload missing or ambiguous');
        const payload = responses[0]!.payload, response = JSON.parse(payload);
        const requests = wire.filter(row => row.direction === 'request' && JSON.parse(row.payload).id === response.id);
        if (requests.length !== 1) throw new Error('Exact native stdio request missing or ambiguous');
        const request = requests[0]!.payload;
        stdoutEmissions.push({ receiptJson, receiptSha256: sha256(receiptJson), payload,
          evidenceRef: stdioWirePath + '#token=' + token,
          stdioRequest: { payload: request, sha256: sha256(request), serverName: 'offline_canary' } });
      }
      return receipt;
    });
    if (options.retainNativeTranscript) {
      if (!nativeSessionId) throw new Error('Native stdout session binding missing');
      // Resolve by the runtime id within this private home, never by recency.
      const originalPath = client === 'codex'
        ? await findCodexRolloutPathByUuid(nativeSessionId, { homeOverride: home })
        : client === 'claude'
          ? await findSessionTranscript(nativeSessionId, { roots: [join(home, '.claude', 'projects')] })
          : await findOmpSessionPath(nativeSessionId, { rootOverride: join(home, 'sessions') });
      if (!originalPath || !originalPath.startsWith(home + '/')) throw new Error('Exact native transcript missing from private home');
      const bytes = readFileSync(originalPath), transcript = bytes.toString('utf8');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024 || !transcript.endsWith('\n')
          || !Buffer.from(transcript).equals(bytes)) throw new Error('Native transcript is incomplete');
      // Keep unmodified JSONL beside diagnostics after private-home cleanup.
      const path = `${home}.native.jsonl`;
      writeFileSync(path, bytes, { mode: 0o600 });
      if (!readFileSync(path).equals(bytes)) throw new Error('Retained native transcript byte mismatch');
      nativeTranscript = { nativeSessionId, bindingEvidenceRef: diagnosticsPath + '#nativeSessionId',
        originalPath, path, transcript, sourceSha256: sha256(bytes), sourceBytes: bytes.length };
    }
    return { client, clientVersion, clientSettings, diagnosticsPath,
      evidencePlane: providerContext ? 'installed-client-provider-context'
        : client === 'omp' ? ompReceipt ? 'installed-client-rpc-output' : 'installed-client-registration' : 'installed-client-local-request',
      request, descriptors, methods,
      ...(nativeTranscript ? { nativeTranscript } : {}),
      ...(receiptOffer ? { stdoutDelivery: { adapter: receiptAdapter, owner: receiptOwner,
        confirmations }, stdoutReceipts, stdoutEmissions } : {}) };
  } catch (error) {
    failure ??= String(error);
    throw new Error(`${failure}; diagnostics: ${diagnosticsPath}`, { cause: error });
  } finally {
    cleanupStarted = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    writeFileSync(diagnosticsPath, JSON.stringify({ client, clientVersion, binary, clientSettings, versionProbe,
      receiptKind: options.stdioReceipt ?? null, receiptPort, stdioFault: options.stdioFault ?? null, maxProviderExchanges,
      stdoutDelivery: receiptOffer ? { adapter: receiptAdapter, owner: receiptOwner,
        confirmations: openDeliveryLedger(receiptOwner, { PAPERCUSP_HOME: home }, 'mcp')?.confirmedMemoryDeliveries() ?? [] } : null,
      pipeProbe: existsSync(pipeProbePath) ? JSON.parse(readFileSync(pipeProbePath, 'utf8')) : null,
      failure, invocation, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null,
      methods, mcpRequests, providerRoutes, requests: captures, frameTypes, stdout, stderr, transportFaults,
      nativeSessionId, nativeSessionState, requestedClaudeSessionId, nativeTranscript, rpcOutputs, stdoutEmissions,
      // Parent environment is measured here; the MCP child's inheritance must
      // be established separately from its actual initialize request metadata.
      environmentScope: 'native-client-parent',
    }, null, 2), { mode: 0o600 });
    options.onDiagnostics?.(diagnosticsPath);
    rmSync(home, { recursive: true, force: true });
  }
}
