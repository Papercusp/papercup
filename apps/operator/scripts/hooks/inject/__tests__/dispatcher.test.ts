/**
 * Tests for the shared context-injection dispatcher.
 * Plan: codex-context-injection-parity-2026-08-09 P-007 (D-001 invariants).
 *
 * ── WHAT IS ACTUALLY BEING ASSERTED, AND WHY IT IS ASSERTED THIS WAY ──
 * The contract is "EXIT 0 AND EMPTY STDOUT", as a PAIR. Each half alone passes
 * trivially and for the wrong reason: a hook that crashes emits empty stdout,
 * and a hook that injects garbage exits 0. Only the conjunction distinguishes
 * "failed silently, as designed" from "failed" and from "succeeded loudly".
 *
 * So the fail-silent cases drive the REAL CLI as a SUBPROCESS rather than
 * calling dispatch() directly: exit code is a property of the process, and a
 * unit test that only inspects a return value cannot observe it. A crash inside
 * an in-process call would surface as a rejected promise the test could catch —
 * i.e. the very failure mode being guarded would be invisible.
 */

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ledgerDir, openDeliveryLedger } from '../delivery-ledger.mjs';
import { contextPackingCarrier, packContextCandidates } from '../../../../../../packages/operator-core/lib/context-doors';

/** Complete typed hook environments without inheriting live host settings. */
function hookEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

it('keeps typed hook fixtures isolated from host operator settings', () => {
  vi.stubEnv('PAPERCUSP_OPERATOR_URL', 'http://host-private.invalid');
  try {
    const env = hookEnv({ PAPERCUSP_SID: 'fixture-owner' });
    expect(env).toEqual({ NODE_ENV: 'test', PAPERCUSP_SID: 'fixture-owner' });
    expect(env.PAPERCUSP_OPERATOR_URL).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable via PROBE_SCRIPT (CLAUDE.md's "Proving a guard is falsifiable"
// tier-2 shape) so scripts/mutation-probe.sh can point this suite at a
// mutated COPY of index.mjs — e.g. with the outer fail-silent catch removed —
// without ever mutating the tracked file (EI-19989482108652654).
const CLI = process.env.PROBE_SCRIPT || path.join(HERE, '..', 'index.mjs');
let cliFixtureRoot: string;
let copiedCli: string;
let cliInvocation = 0;

function copyDispatcher(destination: string) {
  for (const rel of ['', 'adapters']) {
    const src = path.join(HERE, '..', rel);
    const dest = path.join(destination, rel);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      if (name.endsWith('.mjs')) copyFileSync(path.join(src, name), path.join(dest, name));
    }
  }
}

beforeAll(() => {
  // Keep the child loader enabled while executing the exact bytes under test.
  // Repository children otherwise substitute HEAD for dirty hook modules.
  cliFixtureRoot = mkdtempSync(path.join(tmpdir(), 'inject-cli-source-'));
  copyDispatcher(cliFixtureRoot);
  copiedCli = path.join(cliFixtureRoot, 'index.mjs');
  copyFileSync(CLI, copiedCli); // preserve the mutation-probe entry override
});
afterAll(() => rmSync(cliFixtureRoot, { recursive: true, force: true }));

const claude = await import(path.join(HERE, '..', 'adapters', 'claude.mjs'));
const codex = await import(path.join(HERE, '..', 'adapters', 'codex.mjs'));
const ports = await import(path.join(HERE, '..', 'ports.mjs'));

/**
 * A fake operator. Records what it received; answers with injectable text.
 * `opts` is read per request, so a test may mutate it between turns.
 */
function fakeOperator(opts: { text?: string | null; delayMs?: number; deliveryToken?: string; packingReceipt?: { attemptId: string; sha256: string }; memoryFragmentOffers?: object[]; onRequest?: () => void } = {}) {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      opts.onRequest?.();
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            text: opts.text ?? 'INJECTED',
            ...(opts.deliveryToken ? { deliveryToken: opts.deliveryToken } : {}),
            ...(opts.packingReceipt ? { packingReceipt: opts.packingReceipt } : {}),
            ...(opts.memoryFragmentOffers ? { memoryFragmentOffers: opts.memoryFragmentOffers } : {}),
          }),
        );
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  return {
    received,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    },
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Run the real CLI. Returns exit code + stdout — never throws on non-zero. */
async function runCli(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
  cli = copiedCli,
): Promise<{ code: number; stdout: string; stderr: string; hookOutcome: string }> {
  const outcomeFile = path.join(cliFixtureRoot, `outcome-${++cliInvocation}.jsonl`);
  // Preserve the test loader and evidence carriers, but let each fixture own
  // its operator route. Inherited staging markers can redirect even a pinned
  // unavailable URL to a live proxy and turn a denial into an empty verdict.
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key === 'PAPERCUSP_OPERATOR_URL' || key.startsWith('PAPERCUSP_MCP_')) delete inherited[key];
  }
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...inherited, ...env, PAPERCUSP_HOOK_OUTCOME_FILE: outcomeFile }, timeout: 20_000 },
      (err, stdout, stderr) => {
        // Bind to a local before narrowing: two separate `(err as ...).code`
        // cast expressions don't narrow each other, which is what triggered
        // TS2352 here (a genuine, if pre-existing, type-safety gap).
        const rawCode = err ? (err as NodeJS.ErrnoException).code : undefined;
        const signal = err
          ? (err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null }).signal
          : undefined;
        // A signal, timeout, or spawn error has no numeric exit code. Do not
        // collapse it to 0; that made empty child stdout look like success.
        const code = typeof rawCode === 'number' ? rawCode : err ? -1 : 0;
        const diagnostic = err
          ? `execFile error: ${err.message} (code=${String(rawCode ?? 'none')}, signal=${signal ?? 'none'})`
          : '';
        const stderrText = String(stderr);
        resolve({ code, stdout: String(stdout),
          stderr: diagnostic ? [stderrText, diagnostic].filter(Boolean).join('\n') : stderrText,
          hookOutcome: existsSync(outcomeFile) ? readFileSync(outcomeFile, 'utf8') : '' });
      },
    );
    child.stdin?.end(stdin);
  });
}

it('reports signal-terminated CLI children as failures with the signal', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-cli-signal-'));
  const childScript = path.join(root, 'terminate.mjs');
  try {
    writeFileSync(childScript, "process.kill(process.pid, 'SIGTERM');\n");
    const result = await runCli([], '', {}, childScript);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('signal=SIGTERM');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let running: { stop: () => Promise<void> } | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

it('emits the exact OMP stdout newline reserved by final context packing', async () => {
  const text = 'Complete owner duty 字\ncondition';
  const packed = packContextCandidates({ attemptId: 'stdout-budget', budgetBytes: Buffer.byteLength(text) + 1,
    carrier: contextPackingCarrier('omp', 'turn-start'),
    candidates: [{ sourceRef: 'order:14', revision: 'r1', class: 'owner', required: true, text }] });
  const op = fakeOperator({ text: packed.text });
  const base = await op.start();
  running = op;
  const home = mkdtempSync(path.join(tmpdir(), 'inject-carrier-budget-'));
  try {
    const out = await runCli(['--client=omp', '--event=before_agent_start'], JSON.stringify({ prompt: 'measure' }), {
      PAPERCUSP_SID: 'su-native-carrier', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: home,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(text + '\n');
    expect(Buffer.byteLength(out.stdout)).toBe(packed.receipt.contextBytes);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('native stdout memory receipts', () => {
  for (const client of ['codex', 'claude', 'omp'] as const)
    for (const port of (client === 'omp' ? ['turn-start', 'mid-turn'] as const
      : ['turn-start', 'mid-turn', 'compaction'] as const))
      for (const kind of ['memory', 'corpus'] as const)
        for (const failure of ['broken', 'partial'] as const)
        it(`${client} ${port} ${kind}: ${failure} stdout does not confirm; a complete retry does`, async ({ task }) => {
          const home = mkdtempSync(path.join(tmpdir(), 'inject-native-receipt-'));
          const owner = `native-receipt-${client}-${port}-${kind}-${failure}`;
          // Exceed the OS pipe capacity so closing after the first chunk
          // interrupts a pending write, rather than an already complete one.
          const rendered = `- ${kind}: retain the complete snowman ☃ fragment` +
            (failure === 'partial' ? 'x'.repeat(512 * 1024) : '');
          const fragment = { kind, id: kind === 'memory' ? '11111111-1111-1111-1111-111111111111' : 'WI-123',
            epoch: 3, port: port === 'compaction' ? 'compact' : port, rendered, bodyBytes: Buffer.byteLength(rendered),
            bodySha256: createHash('sha256').update(rendered).digest('hex') };
          const opts = { text: rendered, deliveryToken: `receipt-${client}-${port}-${kind}`,
            packingReceipt: { attemptId: `packing-${client}-${port}-${kind}`, sha256: 'a'.repeat(64) },
            memoryFragmentOffers: [fragment] };
          const op = fakeOperator(opts);
          running = op;
          const base = await op.start();
          const env = { ...process.env, PAPERCUSP_SID: owner, PAPERCUSP_HOME: home,
            PAPERCUSP_OPERATOR_URL: base };
          const event = port === 'compaction' ? { source: 'compact', session_id: 'native-compact-receipt' }
            : port === 'turn-start' ? { prompt: 'receipt delivery' }
            : client === 'codex' ? { tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }
            : client === 'claude' ? { tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }] }
            : { message: { content: [{ type: 'toolCall', id: 'call-1', name: 'Grep', arguments: { pattern: 'receipt' } }] },
              toolResults: [{ toolCallId: 'call-1', toolName: 'Grep', content: [{ type: 'text', text: '' }] }] };
          const nativeEvent = port === 'compaction' ? 'SessionStart'
            : port === 'turn-start' ? (client === 'omp' ? 'before_agent_start' : 'UserPromptSubmit')
            : client === 'codex' ? 'PostToolUse' : client === 'claude' ? 'PostToolBatch' : 'turn_end';
          const args = [`--client=${client}`, `--event=${nativeEvent}`];
          const ledgerPort = port === 'compaction' ? 'compact' : port;
          try {
            // Break the actual consumer before writing or after the first
            // bytes. Neither case mocks ledger.commit or dispatch's return.
            const closed = spawn(process.execPath, [copiedCli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
            let partialBytes = 0;
            if (failure === 'broken') closed.stdout.destroy();
            else closed.stdout.once('data', (chunk: Buffer) => {
              partialBytes += chunk.length;
              closed.stdout.destroy();
            });
            closed.stderr.resume();
            const terminal = new Promise<number | null>((resolve, reject) => {
              closed.once('error', reject);
              closed.once('close', resolve);
            });
            closed.stdin.end(JSON.stringify(event));
            await terminal;
            if (failure === 'partial') {
              expect(partialBytes).toBeGreaterThan(0);
              expect(partialBytes).toBeLessThan(fragment.bodyBytes);
            }
            expect(op.received).toHaveLength(1);
            expect(openDeliveryLedger(owner, env, ledgerPort)?.confirmedMemoryDeliveries()).toEqual([]);
            expect(op.received[0]!.body.confirmedMemoryDeliveries).toEqual([]);

            const retry = await runCli(args, JSON.stringify(event), env);
            expect(retry.code).toBe(0);
            expect(retry.stdout).toContain(rendered);
            const { rendered: _text, ...manifest } = fragment;
            const proof = [{ token: opts.deliveryToken, fragments: [manifest] }];
            expect(openDeliveryLedger(owner, env, ledgerPort)?.confirmedMemoryDeliveries()).toEqual(proof);
            const namespace = ledgerPort === 'turn-start' ? owner : `${owner}.${ledgerPort}`;
            const receipt = JSON.parse(readFileSync(path.join(ledgerDir(env), `${namespace}.emissions`,
              `${createHash('sha256').update(opts.deliveryToken).digest('hex')}.json`), 'utf8'));
            const payload = retry.stdout; // Receipt covers the complete framed stdout.
            expect(retry.stdout.endsWith('\n')).toBe(true);
            // Retain the precise broken link even when a failing object matcher
            // elides matching properties from the terminal report.
            Object.assign(task.meta, { packingReceiptJoin: { expected: opts.packingReceipt,
              actual: receipt.packingReceipt ?? null } });
            expect(receipt.packingReceipt).toEqual(opts.packingReceipt);
            expect(receipt).toMatchObject({ stage: 'stdout-emitted', owner, token: opts.deliveryToken, client,
              packingReceipt: opts.packingReceipt,
              payloadSha256: createHash('sha256').update(payload).digest('hex'),
              payloadBytes: Buffer.byteLength(payload), memoryFragments: [manifest] });
            expect(op.received[1]!.body.confirmedMemoryDeliveries).toEqual([]);

            // A subsequent real request, not an arrival-only guess, echoes
            // the proof. Reprinting one token cannot multiply the receipt.
            await runCli(args, JSON.stringify(event), env);
            expect(op.received[2]!.body.confirmedMemoryDeliveries).toEqual(proof);
            expect(openDeliveryLedger(owner, env, ledgerPort)?.confirmedMemoryDeliveries()).toEqual(proof);
            if (port === 'compaction') {
              expect(op.received[0]!.body.memoryReceiptMode).toBe(true);
              expect(op.received[0]!.body).not.toHaveProperty('confirmedDelivery');
              expect(openDeliveryLedger(owner, env)!.confirmed()).toBeNull();
              expect(receipt.nativeSessionId).toBe('native-compact-receipt');
            }
            Object.assign(task.meta, { nativeDispatcherReceipt: {
              client, port, source: kind, failure, partialBytes,
              fragment: manifest, failedOutputReceipts: 0, completeRetryReceipts: 1,
              confirmationEcho: proof, terminalReceipt: receipt,
              evidencePlane: 'real dispatcher subprocess and isolated local receipt store',
              productionBackend: 'UNKNOWN', installedClientConsumption: 'UNKNOWN',
            } });
          } finally {
            rmSync(home, { recursive: true, force: true });
          }
        }, 30_000);
});

describe('standalone installed dispatcher', () => {
  it('ignores inherited staging proxy markers when a fixture pins unavailable authority', async () => {
    const op = fakeOperator({ text: '' });
    const base = await op.start();
    running = op;
    vi.stubEnv('PAPERCUSP_MCP_STAGING_PROXY_PORT', new URL(base).port);
    vi.stubEnv('PAPERCUSP_MCP_PROXY_TARGET_PORT', '3170');
    try {
      const result = await runCli(['--client=codex', '--event=PreToolUse'], JSON.stringify({
        tool_name: 'apply_patch', tool_input: { patch:
          '*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch' },
      }), {
        PAPERCUSP_SID: 'sid-isolated-route', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
        PAPERCUSP_MCP_PROXY_PORT: '9',
      });
      expect(op.received).toHaveLength(0);
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.stdout, JSON.stringify(result)).not.toBe('');
      expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('no server verdict was received'),
      });
      const outcome = JSON.parse(result.hookOutcome.trim());
      expect(outcome.stage).toBe('guard-unavailable-deny');
      expect(outcome.post.operatorOrigin).toBe('http://127.0.0.1:9');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loads and injects without repository node_modules in its ancestry', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'inject-standalone-'));
    const installed = path.join(home, '.papercusp', 'hooks', 'inject');
    const op = fakeOperator({ text: 'STANDALONE-INJECTED' });
    const base = await op.start();
    running = op;
    try {
      // Match installInjectionHooksUnlocked: only sibling/adapters .mjs files ship.
      copyDispatcher(installed);
      const result = await runCli(
        ['--client=claude', '--event=UserPromptSubmit'],
        JSON.stringify({ prompt: 'standalone installation' }),
        { PAPERCUSP_SID: 'sid-standalone', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: home, NODE_PATH: '' },
        path.join(installed, 'index.mjs'),
      );
      expect(result.code).toBe(0);
      // An inherited source loader may report its own preload substitutions on
      // stderr; the hook contract is exit 0 plus the expected stdout payload.
      expect(result.stdout).toContain('STANDALONE-INJECTED');
      expect(op.received).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves scoped evidence reads and refuses native writes with installed authority unavailable', async () => {
    const env = {
      PAPERCUSP_SID: 'sid-installed-evidence',
      PAPERCUSP_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
      PAPERCUSP_MCP_PROXY_PORT: '9',
    };
    const heredoc = (header: string, args: unknown) =>
      [header + " <<'JSON'", JSON.stringify(args), 'JSON'].join('\n');
    const scopedFind = [
      'ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")',
      'if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]; then',
      '  ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")',
      'fi',
      heredoc('ptool tools:find --json - "${ptool_scope[@]}"', { query: 'work_items:get' }),
    ].join('\n');
    for (const cmd of [
      scopedFind,
      heredoc('ptool work_items:get --workspace=papercusp-workspace --harness=papercusp --json -', { id: 'WI-123' }),
      heredoc('ptool work_items:get --json - --workspace=papercusp-workspace --harness=papercusp', { id: 'WI-123' }),
      heredoc('ptool work_items:get --workspace papercusp-workspace --harness papercusp --json -', { id: 'WI-123' }),
      heredoc('ptool facts:list --workspace "$PAPERCUSP_WORKSPACE" --harness "$PAPERCUSP_HARNESS_SLUG" --json -', { scope: 'workspace' }),
      heredoc('ptool tools:find --json - --workspace "$PAPERCUSP_WORKSPACE" --harness "$PAPERCUSP_HARNESS_SLUG"', { query: 'work_items:get' }),
    ]) {
      const result = await runCli(['--client=codex', '--event=PreToolUse'],
        JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd } }), env);
      expect(result.code).toBe(0);
      expect(result.stdout, cmd).toBe('');
    }
    for (const event of [
      { tool_name: 'exec_command', tool_input: { cmd: heredoc(
        'ptool work_items:complete --workspace=papercusp-workspace --json -', { id: 'WI-123', state: 'done' }),
      } },
      { tool_name: 'exec_command', tool_input: { cmd: heredoc(
        'ptool work_items:get --workspace papercusp-workspace --workspace=other --json -', { id: 'WI-123' }),
      } },
      { tool_name: 'exec_command', tool_input: { cmd: scopedFind + '\ntouch source.ts' } },
      { tool_name: 'apply_patch', tool_input: { patch:
        '*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch',
      } },
    ]) {
      const result = await runCli(['--client=codex', '--event=PreToolUse'], JSON.stringify(event), env);
      expect(result.code).toBe(0);
      expect(result.stdout, JSON.stringify({ event, ...result })).not.toBe('');
      expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('no server verdict was received'),
      });
    }
  });

  it('executes the copied current guard for local anchor repair and denies remote destinations', async () => {
    const payload = { slug: 'optional-evaluations', itemId: 'P-002', anchors: [{
      path: 'source.ts', change: { action: 'investigate', summary: 'Inspect source', reason: 'Evaluation only' },
    }] };
    for (const [url, denied] of [['http://127.0.0.1:3170', false], ['http://example.com:3170', true]] as const) {
      const cmd = [`ptool plans:edit --json - --url=${url} <<'JSON'`, JSON.stringify(payload), 'JSON'].join('\n');
      const result = await runCli(['--client=codex', '--event=PreToolUse'],
        JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd } }), {
          PAPERCUSP_SID: 'sid-copied-guard', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9', PAPERCUSP_MCP_PROXY_PORT: '9',
        });
      expect(result.code).toBe(0);
      if (denied) {
        expect(result.stdout, JSON.stringify({ url, ...result })).not.toBe('');
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
      }
      else expect(result.stdout).toBe('');
    }
  });
});

describe('event -> port routing', () => {
  it('claude maps its five boundaries and ignores everything else', () => {
    expect(claude.portForEvent('UserPromptSubmit')).toBe('turn-start');
    expect(claude.portForEvent('PostToolBatch')).toBe('mid-turn');
    // PreToolUse is deliberately NOT mid-turn (D-027): injecting from there
    // requires a permissionDecision, which would auto-approve tool calls. It is
    // the identity GUARD port instead (P-011), which renders only as a deny.
    expect(claude.portForEvent('PreToolUse')).toBe('pre-tool');
    expect(claude.portForEvent('Stop')).toBe('stop');
    expect(claude.portForEvent('SessionStart')).toBe('compaction');
    expect(claude.portForEvent('PostToolUse')).toBeNull();
    expect(claude.portForEvent('SubagentStop')).toBeNull();
  });

  it('codex maps BOTH its config (kebab) and payload (Pascal) spellings', () => {
    const expected: Array<[string[], string]> = [
      [['UserPromptSubmit', 'user-prompt-submit'], 'turn-start'],
      [['PostToolUse', 'post-tool-use'], 'mid-turn'],
      [['PreToolUse', 'pre-tool-use'], 'pre-tool'],
      [['Stop', 'stop'], 'stop'],
      [['SessionStart', 'session-start'], 'compaction'],
    ];
    for (const [events, port] of expected) {
      for (const e of events) expect(codex.portForEvent(e)).toBe(port);
    }
    // Codex has no batch event at all; PostToolBatch is a Claude-only name and
    // must not silently map, or a mis-wired install would look like it worked.
    expect(codex.portForEvent('PostToolBatch')).toBeNull();
    expect(codex.portForEvent('pre-compact')).toBeNull();
  });
});

describe('identity hook ports (P-011): parse / render', () => {
  it('pre-tool ships the whole input, or flags it cut, never a lossy prefix', () => {
    expect(claude.parse('pre-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
      .toEqual({ tool: 'Bash', input: { command: 'ls' } });
    const big = { command: 'x'.repeat(ports.PORTS['pre-tool'].guardInputMaxBytes) };
    expect(claude.parse('pre-tool', { tool_name: 'Bash', tool_input: big })).toEqual({ tool: 'Bash', inputTruncated: true });
    expect(codex.parse('pre-tool', { tool_name: 'shell', tool_input: { command: 'ls' }, cwd: '/repo' }))
      .toEqual({ tool: 'shell', input: { command: 'ls' }, cwd: '/repo' });
    expect(claude.parse('pre-tool', { tool_input: {} })).toBeNull();
  });

  it('pre-tool renders ONLY as a deny, on both clients', () => {
    for (const adapter of [claude, codex]) {
      const out = JSON.parse(adapter.render('pre-tool', 'Refused by identity a rule b: no') as string);
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refused by identity a rule b: no',
        },
      });
    }
  });

  it('stop never re-fires from a stop it already continued', () => {
    for (const adapter of [claude, codex]) {
      expect(adapter.parse('stop', { stop_hook_active: true })).toBeNull();
      expect(adapter.parse('stop', { stop_hook_active: false })).not.toBeNull();
    }
  });

  it('stop renders additionalContext on claude and a block reason on codex (no context channel there)', () => {
    expect(JSON.parse(claude.render('stop', 'S') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'S' },
    });
    expect(JSON.parse(codex.render('stop', 'S') as string)).toEqual({ decision: 'block', reason: 'S' });
  });

  it('compaction fires on startup/clear/compact only, and renders as SessionStart context', () => {
    for (const adapter of [claude, codex]) {
      for (const source of ['startup', 'clear', 'compact']) expect(adapter.parse('compaction', { source })).toMatchObject({ source });
      for (const source of ['resume', 'fork', undefined]) expect(adapter.parse('compaction', { source })).toBeNull();
      expect(JSON.parse(adapter.render('compaction', 'C') as string)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'C' },
      });
    }
  });
});

describe('adapter parse / render', () => {
  it('claude turn-start clamps the prompt to the contract length', () => {
    const parsed = claude.parse('turn-start', { prompt: 'x'.repeat(9_000) }) as { prompt: string };
    expect(parsed.prompt).toHaveLength(4_000);
  });

  it('claude mid-turn clamps to 12 calls x 400 chars per field', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tool_name: `t${i}`,
      tool_input: 'i'.repeat(2_000),
      tool_response: 'r'.repeat(2_000),
    }));
    const parsed = claude.parse('mid-turn', { tool_calls: calls }) as {
      toolCalls: Array<{ toolInput: string; toolResponse: string }>;
    };
    expect(parsed.toolCalls).toHaveLength(12);
    expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    expect(parsed.toolCalls[0].toolResponse).toHaveLength(400);
  });

  it('preserves an edit path beyond the recall clamp for both native and MCP edits', () => {
    for (const tool of ['Edit', 'mcp__papercusp_su__capability_edit', 'capability:edit']) {
      const parsed = codex.parse('mid-turn', { tool_name: tool,
        tool_input: { old_string: 'x'.repeat(2000), file_path: '/repo/lib/example.ts' }, tool_response: 'ok' }) as any;
      expect(parsed.toolCalls[0].editedPath).toBe('/repo/lib/example.ts');
      expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    }
  });

  it('codex mid-turn is PER-CALL and normalises to a one-element array', () => {
    const parsed = codex.parse('mid-turn', {
      tool_name: 'shell',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
      cwd: '/repo',
    }) as { toolCalls: Array<{ tool: string }>; cwd: string };
    // The shape the SERVER sees is identical to claude's, which is what lets one
    // client-agnostic endpoint serve a per-batch and a per-call client.
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('shell');
    // Codex supplies cwd on every event; prefer it over the hook's own cwd.
    expect(parsed.cwd).toBe('/repo');
  });
  it('preserves all native patch headers beyond the recall clamp', () => {
    const patch = `*** Begin Patch\n*** Update File: lib/a.ts\n@@\n-${'x'.repeat(600)}\n+y\n*** Update File: lib/b.ts\n@@\n-a\n+b\n*** End Patch`;
    for (const tool of ['apply_patch', 'functions.apply_patch']) {
      const parsed = codex.parse('mid-turn', { tool_name: tool, tool_input: patch, tool_response: 'ok' }) as any;
      expect(parsed.toolCalls[0].editedPaths).toEqual(['lib/a.ts', 'lib/b.ts']);
      expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    }
  });

  it('recognises Codex command payloads and moved patch destinations before clamping', () => {
    const patch = `*** Begin Patch\n*** Update File: lib/old.ts\n*** Move to: lib/new.ts\n@@\n-${'x'.repeat(600)}\n+y\n*** Add File: lib/added.ts\n+export {};\n*** End Patch`;
    for (const tool of ['apply_patch', 'functions.apply_patch']) {
      for (const toolInput of [{ command: patch }, { patch }, { input: patch }, patch]) {
        const parsed = codex.parse('mid-turn', {
          tool_name: tool, tool_input: toolInput, tool_response: 'ok',
        }) as { toolCalls: Array<{ editedPaths: string[]; toolInput: string }> };
        expect(parsed.toolCalls[0]!.editedPaths).toEqual(['lib/old.ts', 'lib/new.ts', 'lib/added.ts']);
        expect(parsed.toolCalls[0]!.toolInput).toHaveLength(400);
      }
    }
  });

  it('parse returns null when there is no signal, so nothing is spent', () => {
    expect(claude.parse('turn-start', { prompt: 123 })).toBeNull();
    expect(claude.parse('mid-turn', { tool_calls: [] })).toBeNull();
    expect(codex.parse('mid-turn', { tool_name: '' })).toBeNull();
    expect(codex.parse('turn-start', {})).toBeNull();
  });

  it('render echoes the event name each client expects', () => {
    expect(JSON.parse(claude.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'T' },
    });
    expect(JSON.parse(codex.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'T' },
    });
  });
});

describe('kill-switch asymmetry (the load-bearing one)', () => {
  it('turn-start DEGRADES — still calls, with memoryEnabled false', () => {
    // A memory preference must never suppress the CTRL transition riding the
    // same request. If this ever flips to suppress, safety-critical mode/loop/
    // route transitions stop being delivered whenever a user turns memory off.
    const state = ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' });
    expect(state).toEqual({ off: true, mode: 'degrade' });
  });

  it('mid-turn SUPPRESSES — the whole port goes away', () => {
    const state = ports.killSwitchState('mid-turn', { PAPERCUSP_MID_TURN_CONTEXT: 'off' });
    expect(state).toEqual({ off: true, mode: 'suppress' });
  });

  it('the identity ports share ONE switch, and it suppresses', () => {
    for (const port of ['pre-tool', 'stop', 'compaction']) {
      expect(ports.killSwitchState(port, { PAPERCUSP_IDENTITY_HOOKS: 'off' })).toEqual({ off: true, mode: 'suppress' });
    }
  });
});

describe('identity hook ports through the real CLI (P-011)', () => {
  it('does not let a staging tool-guard fall back to an unselected main-build proxy', async () => {
    const { runInjection } = await import('../core.mjs');
    const origins: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.port === '3170') throw new Error('staging unavailable');
      // An older main build without the current plan guard returns no refusal.
      return { ok: true, status: 200, json: async () => ({ text: '' }) } as Response;
    }) as typeof fetch;
    const result = await runInjection({
      adapter: codex,
      nativeEvent: 'pre-tool-use',
      event: { tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch\\n*** End Patch' }, cwd: '/repo' },
      env: hookEnv({
        PAPERCUSP_SID: 'sid-staging-guard',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170',
        PAPERCUSP_MCP_STAGING_PROXY: '0',
      }),
      fetchImpl,
    });

    expect(origins).toEqual(['http://127.0.0.1:3170']);
    expect(result).toContain('plan_execution_not_ready');
    expect(JSON.parse(result!).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('execution-authority lookup failed'),
    });
  });

  it('routes a staging guard with a legacy :9071 pin through the same-build :9171 proxy', async () => {
    const { runInjection } = await import('../core.mjs');
    const origins: string[] = [];
    const stagingVerdict = 'plan_execution_not_ready: staging execution has not started';
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.port === '9171')
        return { ok: true, status: 200, json: async () => ({ text: stagingVerdict }) } as Response;
      throw new Error('unexpected non-staging guard route: ' + url.origin);
    }) as typeof fetch;
    const result = await runInjection({
      adapter: codex,
      nativeEvent: 'pre-tool-use',
      event: { tool_name: 'apply_patch', tool_input: { patch: 'not a real patch' }, cwd: '/repo' },
      env: hookEnv({
        PAPERCUSP_SID: 'sid-staging-guard-legacy-pin',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
        PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
      }),
      fetchImpl,
    });

    expect(origins).toEqual(['http://127.0.0.1:9171']);
    expect(result).toContain('plan_execution_not_ready');
    expect(JSON.parse(result!).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining(stagingVerdict),
    });
  });

  it('falls back from the staging proxy only to the direct staging host', async () => {
    const { runInjection } = await import('../core.mjs');
    const origins: string[] = [];
    const stagingVerdict = 'plan_execution_not_ready: staging execution has not started';
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.port === '9171') throw new Error('staging proxy unavailable');
      if (url.port === '3170')
        return { ok: true, status: 200, json: async () => ({ text: stagingVerdict }) } as Response;
      throw new Error('unexpected non-staging guard route: ' + url.origin);
    }) as typeof fetch;
    const result = await runInjection({
      adapter: codex,
      nativeEvent: 'pre-tool-use',
      event: { tool_name: 'apply_patch', tool_input: { patch: 'not a real patch' }, cwd: '/repo' },
      env: hookEnv({
        PAPERCUSP_SID: 'sid-staging-guard-fallback',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
        PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
      }),
      fetchImpl,
    });

    expect(origins).toEqual(['http://127.0.0.1:9171', 'http://127.0.0.1:3170']);
    expect(result).toContain('plan_execution_not_ready');
    expect(JSON.parse(result!).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining(stagingVerdict),
    });
  });

  it('does not infer staging from an ordinary :9071 pin alone', async () => {
    const { runInjection } = await import('../core.mjs');
    const origins: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      return { ok: true, status: 200, json: async () => ({ text: 'main guard verdict' }) } as Response;
    }) as typeof fetch;
    const result = await runInjection({
      adapter: codex,
      nativeEvent: 'pre-tool-use',
      event: { tool_name: 'apply_patch', tool_input: { patch: 'not a real patch' }, cwd: '/repo' },
      env: hookEnv({
        PAPERCUSP_SID: 'sid-main-guard-pin',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      }),
      fetchImpl,
    });

    expect(origins).toEqual(['http://127.0.0.1:9071']);
    expect(result).toContain('main guard verdict');
  });

  it('pre-tool: a refusal from the operator becomes a deny for that one call', async () => {
    const op = fakeOperator({ text: 'Refused by identity safe-coder rule no-rm: no recursive deletes' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      { PAPERCUSP_SID: 'sid-guard', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Refused by identity safe-coder rule no-rm: no recursive deletes',
    });
    expect(op.received[0].url).toContain('tool-guard');
    expect(op.received[0].body).toMatchObject({ tool: 'Bash', input: { command: 'rm -rf /' }, client: 'claude' });
  });

  it('pre-tool: no verdict emits NOTHING, so the client permission flow decides', async () => {
    const op = fakeOperator({ text: '' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'shell', tool_input: { command: 'ls' }, cwd: '/repo' }),
      { PAPERCUSP_SID: 'sid-guard', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(op.received).toHaveLength(1);
  });

  it('pre-tool: unreachable authority allows canonical plan repairs but keeps unsupported writes closed', async () => {
    const { runInjection } = await import('../core.mjs');
    const fetchImpl = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    const planAnchorRepair = [
      "ptool plans:edit --json - --workspace=papercusp-workspace --harness=papercusp <<'JSON'",
      JSON.stringify({
        slug: 'host-memory-right-sizing-2026-10-31',
        itemId: 'P-001',
        anchors: [{
          path: 'apps/operator/scripts/hooks/inject/core.mjs',
          symbol: 'runInjection',
          change: { action: 'investigate', summary: 'Anchor the guard repair', reason: 'Keep the canonical plan linked to the source.' },
        }],
      }),
      'JSON',
    ].join('\n');
    const contentEdit = [
      "ptool plans:edit --json - <<'JSON'",
      JSON.stringify({ slug: 'host-memory-right-sizing-2026-10-31', old_string: 'old', new_string: 'new' }),
      'JSON',
    ].join('\n');
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const tool of ['apply_patch', 'Write', 'exec_command']) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: tool, tool_input: { cmd: 'touch source.ts' } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl });
        const decision = JSON.parse(output!).hookSpecificOutput;
        expect(decision).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('plan_execution_not_ready'),
        });
        expect(decision.permissionDecisionReason).toContain('no server verdict was received');
      }
      expect(await runInjection({ adapter, nativeEvent, event: { tool_name: 'Read', tool_input: { file_path: 'source.ts' } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl })).toBeNull();
      for (const cmd of ['rg --files apps/operator/scripts/hooks/inject', "rg -n -F 'plan_execution_not_ready' apps/operator/scripts/hooks/inject"]) {
        expect(await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl })).toBeNull();
      }
      for (const cmd of [
        'cat apps/operator/scripts/hooks/inject/core.mjs',
        "sed -n '1,20p' apps/operator/scripts/hooks/inject/core.mjs",
        'rg --files apps/operator/scripts/hooks/inject',
        "rg -n -F 'plan_execution_not_ready' apps/operator/scripts/hooks/inject",
      ]) {
        expect(await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl })).toBeNull();
      }
      for (const cmd of [
        'rg --pre=cat --files .',
        'rg --files; touch source.ts',
        'rg --files --no-config apps/operator/scripts/hooks/inject | head -n 20; touch source.ts',
        'cat source.ts > copy.ts',
        "sed -i 's/old/new/' source.ts",
        "sed -n '1w output' source.ts",
        "sed -n '1,20p' source.ts; touch output",
        "sed -n '1,20p' source.ts > output",
      ]) {
        const output = await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput.permissionDecision).toBe('deny');
      }
      expect(await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd: planAnchorRepair } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl })).toBeNull();
      const admittedContentEdit = await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: contentEdit } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl });
      expect(admittedContentEdit).toBeNull();
    }
  });

  it('pre-tool: unreachable authority admits everyday read-only wrappers but keeps writes closed (EI-28725785038939067)', async () => {
    const { runInjection } = await import('../core.mjs');
    const fetchImpl = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    // Shapes agents actually type for reads; the old fallback admitted only bare rg/head/cat/sed/ps.
    const admitted = [
      'cd apps/operator && rg -n -F runInjection scripts/hooks/inject/core.mjs',
      'timeout 20 rg -n -F runInjection apps/operator/scripts/hooks/inject 2>/dev/null | head -n 5',
      'grep -rn plan_execution_not_ready apps/operator/scripts/hooks/inject 2>&1 | head -20',
      'ls -la apps/operator/scripts/hooks/inject | wc -l',
      "echo '--- core ---'; tail -n 20 apps/operator/scripts/hooks/inject/core.mjs",
      'rg -c runInjection apps/operator/scripts/hooks/inject | sort -t: -k2 -rn | uniq -c',
      'rg --files apps/operator/scripts/hooks/inject > /dev/null || true',
      'pwd; cut -d: -f1 apps/operator/package.json | head -n 3',
      'timeout -s KILL 5s ps -eo pid,comm | grep -F node',
    ];
    const refused = [
      'cd apps && touch source.ts',
      'rg --files 2>errors.log',
      'ls > listing.txt',
      'grep -rn x . >> out.txt',
      'echo hi >& out.txt',
      'sort -o sorted.txt input.txt',
      'sort -uo sorted.txt input.txt',
      'sort --output=sorted.txt input.txt',
      'sort --compress-program=sh input.txt',
      'uniq input.txt output.txt',
      'timeout 5 touch source.ts',
      'timeout 5',
      'timeout rg --files',
      'rg --files || touch source.ts',
      'cd a b',
      'ls $HOME',
      'find . -name x -delete',
    ];
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const cmd of admitted) {
        expect(await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl }), cmd).toBeNull();
      }
      for (const cmd of refused) {
        const output = await runInjection({ adapter, nativeEvent, event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl });
        expect(output, cmd).not.toBeNull();
        expect(JSON.parse(output!).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
      }
    }
  });

  it('pre-tool: unavailable authority permits typed plan edits on local staging but refuses arbitrary destinations and shell execution', async () => {
    const { runInjection } = await import('../core.mjs');
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const payload = { slug: 'optional-evaluations', itemId: 'P-002', anchors: [{
      path: 'packages/operator-core/lib/harness/docs/native-architecture.ts',
      change: { action: 'investigate', summary: 'Evaluate current source citations', reason: 'Evaluation only' },
    }] };
    const textEdit = { slug: 'optional-evaluations', old_string: 'old plan text',
      new_string: 'repaired plan text', expectedHash: 'a'.repeat(64), rationale: 'Repair before activation' };
    const command = (flags: string, body: unknown = payload) =>
      [`ptool plans:edit ${flags} <<'JSON'`, JSON.stringify(body), 'JSON'].join('\n');
    const safe = [
      command('--url http://127.0.0.1:3170 --json -'),
      command('--json - --url=http://localhost:3170/ --harness=papercusp'),
      command('--json - --url "http://[::1]:3170" --workspace=papercusp-workspace'),
      command('--json - --url=http://127.0.0.1:3170 --harness=papercusp', textEdit),
    ];
    const unsafe = [
      ...['http://example.com:3170', 'http://127.0.0.1:39047', 'http://127.0.0.1:3170.evil',
        'http://user@127.0.0.1:3170', 'http://127.0.0.1:3170/path',
        'http://127.0.0.1:3170?next=elsewhere', 'http://127.0.0.1:3170#fragment']
        .map(url => command(`--json - --url=${url}`)),
      command('--json - --url=http://127.0.0.1:3170 --url=http://localhost:3170'),
      command('--json - --url=http://127.0.0.1:3170; touch source.ts'),
      command('--json - --url=http://127.0.0.1:3170 --extra=write'),
      command('--json - --url=http://127.0.0.1:3170', { ...payload, old_string: 'old', new_string: 'new' }),
    ];
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const cmd of safe) expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-anchor-repair' }), fetchImpl }), cmd).toBeNull();
      for (const cmd of unsafe) {
        const result = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-anchor-repair' }), fetchImpl });
        expect(JSON.parse(result!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: unavailable authority admits typed pre-start plans:audit and invoke retries only', async () => {
    const { runInjection } = await import('../core.mjs');
    const ptool = (name: string, args: unknown, flags = '') =>
      ['ptool ' + name + (flags ? ' ' + flags : '') + " --json - <<'JSON'",
        JSON.stringify(args), 'JSON'].join('\n');
    const textEdit = { slug: 'repair-plan', harness: 'papercusp', old_string: 'stale anchor',
      new_string: 'repaired anchor', expectedHash: 'b'.repeat(64), rationale: 'Repair before plan start' };
    const activationAudit = { slug: 'repair-plan', harness: 'papercusp', phase: 'activation', dryRun: false,
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'codex-session-1', fromTurn: 0, toTurn: 1 }],
      mappings: [{ id: 'M-001', sourceRefs: ['codex-session-1:turn:0'], requirement: 'Repair plan readiness',
        planTargets: ['P-001'], disposition: 'covered' }] };
    const discoveryAudit = { slug: 'repair-plan', harness: 'papercusp', phase: 'discovery', dryRun: false };
    const safe = [
      ptool('plans:edit', textEdit, '--workspace=papercusp-workspace --harness=papercusp'),
      ptool('tools:invoke', { name: 'plans:edit', args: textEdit }),
      ptool('plans:audit', discoveryAudit),
      ptool('tools:invoke', { name: 'plans:audit', args: activationAudit },
        '--idempotency-key=fe2d13ae-60b6-4054-bd68-3b3631f7a27f'),
    ];
    const unsafe = [
      ptool('plans:edit', { ...textEdit, replace_all: true }),
      ptool('plans:edit', { ...textEdit, allowDecisionDrop: true }),
      ptool('plans:edit', { ...textEdit, itemId: 'P-001', anchors: [{ path: 'source.ts' }] }),
      ptool('plans:audit', { ...activationAudit, phase: 'completion',
        items: [{ itemId: 'P-001', verdict: 'implemented' }] }),
      ptool('tools:invoke', { name: 'plans:audit', args: activationAudit, projection: { pick: ['status'] } }),
      ptool('tools:invoke', { name: 'capability:write', args: { file_path: 'source.ts', content: 'changed' } }),
      ptool('tools:invoke', { name: 'plans:audit', args: activationAudit },
        '--idempotency-key=$(touch source.ts)'),
    ];
    const unavailable = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const explicitRefusal = (async () => new Response(JSON.stringify({ text: 'Target plan repair refusal' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      const env = { PAPERCUSP_SID: 'sid-plan-repair', PAPERCUSP_WORKSPACE: 'papercusp-workspace',
        PAPERCUSP_HARNESS_SLUG: 'papercusp' };
      for (const cmd of safe) expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl: unavailable }), cmd).toBeNull();

      const targetRefusal = await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: safe[3] } }, env: hookEnv(env), fetchImpl: explicitRefusal });
      expect(JSON.parse(targetRefusal!).hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny', permissionDecisionReason: 'Target plan repair refusal',
      });

      for (const cmd of unsafe) {
        const refused = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl: unavailable });
        expect(JSON.parse(refused!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: unavailable authority permits only bounded reviewer read/control calls, including one invoke wrapper', async () => {
    const { runInjection } = await import('../core.mjs');
    const ptool = (name: string, args: unknown) =>
      [`ptool ${name} --json - <<'JSON'`, JSON.stringify(args), 'JSON'].join('\n');
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const read = ptool('conversations:get', { id: 'consult-1' });
    const decline = ptool('consult:decline', { conversation_id: 'consult-1', reason: 'Cannot read evidence: $() `literal`' });
    const safe = [read, decline,
      ptool('tools:invoke', { name: 'conversations:get', args: { id: 'consult-1' } }),
      ptool('tools:invoke', { name: 'consult:decline', args: { conversation_id: 'consult-1', reason: 'blocked' } }),
    ];
    const unsafe = [
      ptool('tools:invoke', { name: 'capability:write', args: { file_path: 'source.ts', content: 'changed' } }),
      ptool('tools:invoke', { name: 'tools:invoke', args: { name: 'conversations:get', args: { id: 'consult-1' } } }),
      ptool('tools:invoke', { name: 'conversations:get', args: {}, authenticatedPrincipal: 'someone-else' }),
      read + '\ntouch source.ts', read.replace("<<'JSON'", '<<JSON'),
      read.replace('ptool ', 'FAKE=1 ptool '), read.replace(' --json', ' --url=http://elsewhere --json'),
      'touch source.ts',
    ];
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const cmd of safe) expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-reviewer' }), fetchImpl }), cmd).toBeNull();
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-reviewer' }), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: unavailable authority admits pinned plan evaluation reads but keeps writes and remote URLs closed', async () => {
    const { runInjection } = await import('../core.mjs');
    const args = {
      harness: 'papercusp',
      slug: 'agent-latency-causes-remediation-2026-11-06',
      detail: 'summary',
    };
    const command = (header: string, payload: unknown) =>
      [header + " <<'JSON'", JSON.stringify(payload), 'JSON'].join('\n');
    const evaluate = command('ptool plans:evaluate-spec-quality --json - --url=http://127.0.0.1:3170', args);
    const unsafe = [
      command('ptool plans:evaluate-spec-quality --json - --url=http://example.com:3170', args),
      command('ptool work_items:complete --json - --url=http://127.0.0.1:3170', {
        id: 'EI-28073769942770404', state: 'resolved',
      }),
    ];
    const unavailable = (async () => { throw new Error('authority unavailable'); }) as typeof fetch;
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: evaluate } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-plan-evaluation' }), fetchImpl: unavailable }), evaluate).toBeNull();
      const refusal = await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: evaluate } },
        env: hookEnv({ PAPERCUSP_SID: 'sid-plan-evaluation' }),
        fetchImpl: (async () => new Response(JSON.stringify({ text: 'Explicit operator refusal' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch });
      expect(JSON.parse(refusal!).hookSpecificOutput, evaluate).toMatchObject({
        permissionDecision: 'deny', permissionDecisionReason: 'Explicit operator refusal',
      });
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-plan-evaluation' }), fetchImpl: unavailable });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: unavailable authority permits pinned scorecard evidence paging without admitting writes or shell execution', async () => {
    const { runInjection } = await import('../core.mjs');
    const command = (header: string, args: unknown = { issueId: 'EI-123', rerunRecipeOffset: 2580 }) =>
      [header + " <<'JSON'", JSON.stringify(args), 'JSON'].join('\n');
    const pinned = 'node scripts/mcp-call.mjs --port 38453 scorecards:get --json -';
    const pinnedGitEvidence = 'node scripts/mcp-call.mjs --port=3170 capability:git-evidence --json -';
    const pinnedToolsFind = 'node scripts/mcp-call.mjs --port=3170 tools:find --json -';
    const safe = [
      command('ptool scorecards:get --json -'),
      command('ptool scorecards:get --json - --url=http://127.0.0.1:3170'),
      command(pinned),
      command(pinned + ' --allow-partial'),
      command(pinnedGitEvidence, {
        op: 'readFileAtCommit', commitSha: 'a'.repeat(40), path: 'apps/operator/scripts/hooks/inject/core.mjs',
        rootHarnessSlug: 'papercusp', byte_offset: 37050, byte_limit: 3072,
      }),
      command(pinnedToolsFind, { query: 'scorecards:emit' }),
      command('node scripts/mcp-call.mjs --port=38453 capability:read --json -', {
        file_path: 'papercusp://scratch/papercusp-workspace/scorecards:get/evidence.spill',
        byte_offset: 0, byte_limit: 3072,
      }),
      command('ptool tools:invoke --json -', { name: 'scorecards:get', args: { issueId: 'EI-123' } }),
    ];
    const unsafe = [
      command(pinned.replace('scorecards:get', 'scorecards:emit')),
      command(pinned.replace('scorecards:get', 'work_items:complete')),
      command(pinned.replace('scorecards:get', 'tools:invoke'), {
        name: 'scorecards:get', args: { issueId: 'EI-123' },
      }),
      command(pinnedToolsFind.replace('tools:find', 'tools:invoke'), {
        name: 'tools:find', args: { query: 'scorecards:emit' },
      }),
      command(pinned + ' --client=someone-else'),
      command(pinned.replace('38453', '65536')),
      command(pinned.replace('38453', '0')),
      command(pinned.replace('scripts/mcp-call.mjs', '/tmp/mcp-call.mjs')),
      command(pinned.replace('node ', 'node --eval ')),
      command(pinned).replace("<<'JSON'", '<<JSON'),
      command(pinned) + '\ntouch source.ts',
      command(pinned + ' > source.ts'),
      command('ptool scorecards:get --json - --url=http://elsewhere:3170'),
      command('ptool scorecards:get --json - --url=http://127.0.0.1:3170/path'),
    ];
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const cmd of safe) {
        expect(await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-reviewer' }), fetchImpl }), cmd).toBeNull();
        const refusal = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-reviewer' }),
          fetchImpl: (async () => new Response(JSON.stringify({ text: 'Explicit operator refusal' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })) as typeof fetch });
        expect(JSON.parse(refusal!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: 'Explicit operator refusal',
        });
      }
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-reviewer' }), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({ permissionDecision: 'deny' });
      }
    }
  });

  it('pre-tool: unavailable authority accepts only validated quoted scope refs for typed ptool reads', async () => {
    const { runInjection } = await import('../core.mjs');
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const ptool = (name: string, scopeArgs: string, args: unknown) =>
      [`ptool ${name} --json -${scopeArgs} <<'JSON'`, JSON.stringify(args), 'JSON'].join('\n');
    const safe = [
      ptool('work_items:get', ' --workspace="$PAPERCUSP_WORKSPACE"', { id: 'WI-123' }),
      ptool('events:status', ' --workspace="${PAPERCUSP_WORKSPACE}" --harness="${PAPERCUSP_HARNESS_SLUG}"',
        { event: 'harness:papercusp:source-ready:test' }),
    ];
    const unsafe = [
      ptool('work_items:get', ' --workspace="$HOME"', { id: 'WI-123' }),
      ptool('work_items:get', ' --harness="$PAPERCUSP_WORKSPACE"', { id: 'WI-123' }),
      ptool('work_items:get', ' --workspace=$PAPERCUSP_WORKSPACE', { id: 'WI-123' }),
      ptool('work_items:get', ' --workspace="$PAPERCUSP_WORKSPACE" --workspace=papercusp-workspace', { id: 'WI-123' }),
      ptool('events:emit', ' --workspace="$PAPERCUSP_WORKSPACE"', { event: 'test' }),
    ];
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      const env = {
        PAPERCUSP_SID: 'sid-reviewer',
        PAPERCUSP_WORKSPACE: 'papercusp-workspace',
        PAPERCUSP_HARNESS_SLUG: 'papercusp',
      };
      for (const cmd of safe) expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl }), cmd).toBeNull();
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
      const invalidScope = await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: safe[0] } },
        env: hookEnv({ ...env, PAPERCUSP_WORKSPACE: 'workspace; touch source.ts' }), fetchImpl });
      expect(JSON.parse(invalidScope!).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('pre-tool: typed read scopes may precede JSON flags without admitting writes or shell effects', async () => {
    const { runInjection } = await import('../core.mjs');
    const command = (header: string, args: unknown = { id: 'WI-123' }) =>
      [header + " <<'JSON'", JSON.stringify(args), 'JSON'].join('\n');
    const safe = [
      command('ptool work_items:get --workspace=papercusp-workspace --harness=papercusp --json -'),
      command('ptool work_items:get --harness=papercusp --json - --workspace=papercusp-workspace'),
      command('ptool work_items:get --url=http://127.0.0.1:3170 --workspace=papercusp-workspace --json -'),
      command('ptool work_items:get --workspace="$PAPERCUSP_WORKSPACE" --json - --harness="${PAPERCUSP_HARNESS_SLUG}"'),
      command('ptool tools:invoke --workspace=papercusp-workspace --json -', {
        name: 'work_items:get', args: { id: 'WI-123' },
      }),
    ];
    const unsafe = [
      command('ptool work_items:complete --workspace=papercusp-workspace --json -'),
      command('ptool work_items:get --workspace=papercusp-workspace --json - --workspace=papercusp-workspace'),
      command('ptool work_items:get --workspace="$HOME" --json -'),
      command('ptool work_items:get --workspace=papercusp-workspace --json - --json -'),
      command('ptool work_items:get --url=http://elsewhere:3170 --workspace=papercusp-workspace --json -'),
      command('ptool work_items:get --workspace=papercusp-workspace --json - > source.ts'),
      command('ptool work_items:get --workspace=papercusp-workspace --json -') + '\ntouch source.ts',
      command('ptool work_items:get --workspace=papercusp-workspace --json -').replace("<<'JSON'", '<<JSON'),
    ];
    const env = { PAPERCUSP_SID: 'sid-reviewer', PAPERCUSP_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_HARNESS_SLUG: 'papercusp' };
    const unavailable = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      for (const cmd of safe) {
        const event = { tool_name: 'exec_command', tool_input: { cmd } };
        expect(await runInjection({ adapter, nativeEvent, event, env: hookEnv(env), fetchImpl: unavailable }), cmd).toBeNull();
        const refusal = await runInjection({ adapter, nativeEvent, event, env: hookEnv(env),
          fetchImpl: (async () => new Response(JSON.stringify({ text: 'Explicit operator refusal' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })) as typeof fetch });
        expect(JSON.parse(refusal!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny', permissionDecisionReason: 'Explicit operator refusal',
        });
      }
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl: unavailable });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({ permissionDecision: 'deny' });
      }
    }
  });

  it('pre-tool: unavailable authority permits read-only diagnostics and exact grading-audit recovery waits', async () => {
    const { runInjection } = await import('../core.mjs');
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const ptool = (name: string, scopeArgs: string, args: unknown) => [
      'ptool ' + name + ' --json -' + scopeArgs + " <<'JSON'",
      JSON.stringify(args),
      'JSON',
    ].join('\n');
    const auditEvent = 'scorecard:grading-audit:EI-27971621607670989';
    const auditAwait = { event: auditEvent, timeout_sec: 600, on_timeout: 'wake' };
    const safe = [
      ptool('dev:pg_query', ' --workspace="$PAPERCUSP_WORKSPACE"', { sql: 'SELECT 1' }),
      ptool('tools:invoke', ' --workspace="$PAPERCUSP_WORKSPACE"', {
        name: 'dev:pg_query', args: { sql: 'SELECT 1' },
      }),
      ptool('events:await', '', auditAwait),
      ptool('tools:invoke', '', { name: 'events:await', args: auditAwait }),
      ptool('tools:find', '', { query: 'capability:bash' }),
    ];
    const unsafe = [
      ptool('events:await', '', { ...auditAwait, event: 'unrelated:event' }),
      ptool('events:await', '', { ...auditAwait, event: auditEvent + ':suffix' }),
      ptool('events:await', '', { ...auditAwait, timeout_sec: 3601 }),
      ptool('events:await', '', { ...auditAwait, on_timeout: 'expire' }),
      ptool('events:await', '', { ...auditAwait, payload_filter: { ok: true } }),
      ptool('watch:create', '', { targetKind: 'event', pattern: auditEvent, wake: true, once: true }),
      ptool('tools:invoke', '', {
        name: 'events:await', args: auditAwait, authenticatedPrincipal: 'someone-else',
      }),
    ];
    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      const env = { PAPERCUSP_SID: 'sid-recovery', PAPERCUSP_WORKSPACE: 'papercusp-workspace' };
      for (const cmd of safe) expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl }), cmd).toBeNull();
      for (const cmd of unsafe) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(env), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput, cmd).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: unavailable authority permits documented scoped ptool reads only', async () => {
    const { runInjection } = await import('../core.mjs');
    const scopedPtool = (tool: string, args: unknown) => [
      'ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")',
      'if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]; then',
      '  ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")',
      'fi',
      'ptool ' + tool + ' --json - "${ptool_scope[@]}" <<\'JSON\'',
      JSON.stringify(args),
      'JSON',
    ].join('\n');
    const safe = scopedPtool('tools:find', { query: 'work_items:claim' });
    const safeTestingRuns = [
      "ptool testing:runs --workspace=papercusp-workspace --harness=papercusp --json - <<'JSON'",
      JSON.stringify({ limit: 1 }),
      'JSON',
    ].join('\n');
    const unsafe = scopedPtool('work_items:complete', { id: 'WI-123', state: 'done' });
    const unsafeCheckpoint = scopedPtool('work_items:checkpoint', { id: 'WI-123', checkpoint: 'attempt' });
    const fetchImpl = (async () => { throw Error('authority unavailable'); }) as typeof fetch;
    const env = {
      PAPERCUSP_SID: 'sid-scoped-find',
      PAPERCUSP_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
    };

    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: safe } }, env: hookEnv(env), fetchImpl })).toBeNull();
      expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: safeTestingRuns } }, env: hookEnv(env), fetchImpl })).toBeNull();
      expect(await runInjection({ adapter, nativeEvent,
        event: { tool_name: 'exec_command', tool_input: { cmd: safe } },
        env: hookEnv({ ...env, PAPERCUSP_HARNESS_SLUG: '' }), fetchImpl })).toBeNull();

      for (const [cmd, callEnv] of [
        [unsafe, env],
        [unsafeCheckpoint, env],
        [safe, { ...env, PAPERCUSP_HARNESS_SLUG: 'papercusp;touch' }],
      ] as const) {
        const output = await runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd } }, env: hookEnv(callEnv), fetchImpl });
        expect(JSON.parse(output!).hookSpecificOutput).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('no server verdict was received'),
        });
      }
    }
  });

  it('pre-tool: a wall during authority fetch permits grouped read-only inspection but still denies writes', async () => {
    const { runInjection } = await import('../core.mjs');
    const stalledFetch = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
    const readOnlyInspection = [
      'rg --files apps/operator/scripts/hooks/inject',
      "rg -n -F 'plan_execution_not_ready' apps/operator/scripts/hooks/inject",
      "sed -n '1,20p' apps/operator/scripts/hooks/inject/core.mjs",
    ].join('\n');
    const reportedReadOnlyReads = [
      "sed -n '2670,2825p' packages/operator-core/lib/agent-tools/capability/launch-agent.ts",
      "sed -n '2855,2960p' packages/operator-core/lib/agent-tools/capability/launch-agent.ts",
      "rg -n 'reconcilePendingGradingAudits|dispatch.*Audit|launchSummary|dispatchReservation|launch-agent' packages/operator-core/lib/grading-audit-routing.ts packages/operator-core/lib/scorecards.ts",
    ].join('\n');
    // A pipe is admitted only when every stage is independently allowlisted as
    // read-only; unknown commands and writes remain fail-closed.
    const reportedReadOnlyPipeline = [
      "rg --files --no-config packages/operator-core/lib | rg --no-config '(agent-launch|launch-ledger|spawn-attempt)'",
      "ps -eo pid,comm | rg --no-config -F 'codex'",
      'rg --files --no-config apps/operator/scripts/hooks/inject | head -n 20',
      "rg --no-config -n -F 'plan_execution_not_ready' apps/operator/scripts/hooks/inject | head -n 20",
    ].join('\n');
    const readOnlyCommands = [
      readOnlyInspection,
      reportedReadOnlyReads,
      "rg -n -C 2 'plan_execution_not_ready|isSafeWithoutExecutionAuthority' apps/operator/scripts/hooks/inject/core.mjs",
      [
        "ptool tools:find --json - <<'JSON'",
        '{"query":"plans:get"}',
        'JSON',
      ].join('\n'),
      [
        "ptool reports:get --json - --harness=papercusp <<'JSON'",
        '{"id":"report-1"}',
        'JSON',
      ].join('\n'),
      [
        "ptool consult:reply --json - --harness=papercusp <<'JSON'",
        '{"conversation_id":"consult-1","kind":"answer","body":"Reviewed.","evidence":[{"session_id":"session-1","turn_idx":3}]}',
        'JSON',
      ].join('\n'),
      [
        "ptool dev:pg_query --json - --workspace=\"$PAPERCUSP_WORKSPACE\" <<'JSON'",
        '{"sql":"SELECT 1"}',
        'JSON',
      ].join('\n'),
      [
        "ptool events:await --json - <<'JSON'",
        '{"event":"scorecard:grading-audit:EI-27971621607670989","timeout_sec":600,"on_timeout":"wake"}',
        'JSON',
      ].join('\n'),
    ];
    const refusedPtoolWrite = [
      "ptool work_items:set_state --json - <<'JSON'",
      '{"id":"WI-123","state":"done"}',
      'JSON',
    ].join('\n');

    for (const [adapter, nativeEvent] of [[claude, 'PreToolUse'], [codex, 'pre-tool-use']] as const) {
      vi.useFakeTimers();
      try {
        for (const cmd of readOnlyCommands) {
          const read = runInjection({ adapter, nativeEvent,
            event: { tool_name: 'exec_command', tool_input: { cmd } },
            env: hookEnv({ PAPERCUSP_SID: 'sid-guard', PAPERCUSP_WORKSPACE: 'papercusp-workspace' }),
            fetchImpl: stalledFetch });
          await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
          expect(await read, cmd).toBeNull();
        }

        const pipeline = runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd: reportedReadOnlyPipeline } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl: stalledFetch });
        await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
        expect(await pipeline).toBeNull();

        const mutatingPipeline = runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd: 'ps -eo pid,comm | touch output' } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl: stalledFetch });
        await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
        expect(JSON.parse((await mutatingPipeline)!).hookSpecificOutput).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('plan_execution_not_ready'),
        });

        const write = runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd: 'touch source.ts' } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl: stalledFetch });
        await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
        const decision = JSON.parse((await write)!).hookSpecificOutput;
        expect(decision).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('plan_execution_not_ready'),
        });
        const nativePatch = runInjection({ adapter, nativeEvent,
          event: { tool_name: 'apply_patch', tool_input: {
            patch: '*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch',
          } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl: stalledFetch });
        await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
        const patchDecision = JSON.parse((await nativePatch)!).hookSpecificOutput;
        expect(patchDecision).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('plan_execution_not_ready'),
        });
        expect(patchDecision.permissionDecisionReason).toContain('stage=wall-during-fetch');
        expect(patchDecision.permissionDecisionReason).toContain('timeoutMs=1500');
        const ptoolWrite = runInjection({ adapter, nativeEvent,
          event: { tool_name: 'exec_command', tool_input: { cmd: refusedPtoolWrite } },
          env: hookEnv({ PAPERCUSP_SID: 'sid-guard' }), fetchImpl: stalledFetch });
        await vi.advanceTimersByTimeAsync(ports.PORTS['pre-tool'].timeoutMs);
        expect(JSON.parse((await ptoolWrite)!).hookSpecificOutput).toMatchObject({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('plan_execution_not_ready'),
        });
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('stop and compaction reach their endpoints and render per client', async () => {
    const op = fakeOperator({ text: 'IDENTITY CONTEXT' });
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-sinks', PAPERCUSP_OPERATOR_URL: base };
    const stop = await runCli(['--client=codex', '--event=Stop'], JSON.stringify({ stop_hook_active: false, cwd: '/repo' }), env);
    expect(JSON.parse(stop.stdout)).toEqual({ decision: 'block', reason: 'IDENTITY CONTEXT' });
    const compaction = await runCli(['--client=claude', '--event=SessionStart'], JSON.stringify({ source: 'compact' }), env);
    expect(JSON.parse(compaction.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'IDENTITY CONTEXT' },
    });
    expect(op.received.map((r) => r.url)).toEqual([
      expect.stringContaining('stop-context'), expect.stringContaining('compaction-context'),
    ]);
    expect(op.received[1].body).toMatchObject({ source: 'compact' });
  });

  it('the kill switch means no request at all', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      { PAPERCUSP_SID: 'sid-off', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_IDENTITY_HOOKS: 'off' },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(op.received).toHaveLength(0);
  });
});

describe('the happy path (so the fail-silent tests below are not vacuous)', () => {
  it('injects, and stamps the client on the request', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hello' }),
      { PAPERCUSP_SID: 'sid-1', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code, res.stderr || 'execFile returned no error detail').toBe(0);
    expect(res.stdout, res.stderr || 'the CLI exited successfully without emitting its required JSON payload').not.toBe('');
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'INJECTED' },
    });
    // P-005: without this the coverage query cannot tell "codex got nothing"
    // from "codex was never asked".
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.client).toBe('codex');
    expect(op.received[0].url).toContain('turn-start-memory');
  });

  it('carries the private mid-turn detector key separately from the public owner', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      {
        PAPERCUSP_SID: 'public-owner',
        PAPERCUSP_FAILURE_LOOP_SESSION_KEY: 'private-detector',
        PAPERCUSP_OPERATOR_URL: base,
      },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('public-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('private-detector');
  });

  it('falls back to the public owner for legacy hook environments without a carrier', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      { PAPERCUSP_SID: 'legacy-owner', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('legacy-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('legacy-owner');
  });
});

describe('CTRL target-owner fence', () => {
  it('drops a foreign CTRL block but preserves following context', async () => {
    const op = fakeOperator({
      text: '⟦CTRL:transition⟧ {"targetOwnerId":"sid-previous"}\n\n## Orientation\nkeep this',
    });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    const output = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    expect(output).not.toContain('CTRL:');
    expect(output).toContain('## Orientation\nkeep this');
  });

  it('keeps a CTRL block addressed to the requesting owner', async () => {
    const op = fakeOperator({ text: '⟦CTRL:full-resync⟧ {"targetOwnerId":"sid-current"}' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('CTRL:full-resync');
  });
});

describe('fail-silent: EXIT 0 AND EMPTY STDOUT (D-001 invariant 1)', () => {
  const cases: Array<{ name: string; args: string[]; stdin: string; env: Record<string, string> }> =
    [
      {
        name: 'no PAPERCUSP_SID (not a psu session)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: '' },
      },
      {
        name: 'mid-turn kill-switch off',
        args: ['--client=claude', '--event=PostToolBatch'],
        stdin: JSON.stringify({ tool_calls: [{ tool_name: 'B' }] }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_MID_TURN_CONTEXT: 'off' },
      },
      {
        name: 'malformed stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '{not json at all',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'empty stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown client',
        args: ['--client=nosuchtui', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown event',
        args: ['--client=claude', '--event=NoSuchEvent'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'missing flags entirely',
        args: [],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'operator down (connection refused)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        // Reserved-by-convention discard port: nothing listens, connect fails fast.
        // The proxy fallback (WI-10005007) is pointed at a dead port too: a loopback
        // pin that is refused is retried on the MCP proxy, which on a dev box is a
        // LIVE operator — without this the case would quietly measure the real one.
        env: { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9', PAPERCUSP_MCP_PROXY_PORT: '9' },
      },
      {
        // EI-19989482108652654: the 8 cases above are all absorbed by dispatch()'s
        // OWN try/catch, so none of them can observe whether the OUTER catch at the
        // bottom of index.mjs (`dispatch().then(...).catch(() => process.exit(0))`)
        // still exists. This case forces dispatch() itself to reject (via the
        // test-only env seam), which only the outer catch can absorb — deleting
        // that line turns this into an unhandled promise rejection (Node exits
        // non-zero), so this case is what makes that line's removal detectable.
        name: 'unexpected throw reaching dispatch() (outer catch, not the inner one)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_INJECT_TEST_FORCE_THROW: '1' },
      },
    ];

  for (const c of cases) {
    it(`${c.name} -> exit 0, no output`, async () => {
      const res = await runCli(c.args, c.stdin, c.env);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');
    });
  }

  it('loopback pin refused -> the turn is served by the MCP proxy instead (WI-10005007)', async () => {
    // A staging-pinned session (PAPERCUSP_OPERATOR_URL=:3170) whose pin is down
    // used to get NOTHING at turn start: no CTRL, no orientation, no memory, and
    // no ACK-ON-PROOF token, so an in-place identity activation could not apply.
    const op = fakeOperator({ text: 'VIA-PROXY' });
    const base = await op.start();
    running = op;
    const proxyPort = new URL(base).port;
    const res = await runCli(['--client=claude', '--event=UserPromptSubmit'], JSON.stringify({ prompt: 'hi' }), {
      PAPERCUSP_SID: 'sid-fallback',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
      PAPERCUSP_MCP_PROXY_PORT: proxyPort,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('VIA-PROXY');
    expect(op.received).toHaveLength(1);
    expect(op.received[0]?.url).toBe('/api/agent-mcp/turn-start-memory');
    expect(op.received[0]?.body.owner).toBe('sid-fallback');
  });

  it('operator SLOWER than the port wall -> exit 0, no output', async () => {
    // mid-turn's wall is 1.5s; answer at 4s. The turn must proceed un-augmented
    // rather than wait — a slow operator costs the turn nothing.
    let receivedAt: number | undefined;
    const op = fakeOperator({ delayMs: 4_000, onRequest: () => { receivedAt = performance.now(); } });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({ tool_calls: [{ tool_name: 'B', tool_input: 'x', tool_response: 'y' }] }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    // Measure the request wall, excluding process/loader startup. Requiring a
    // received request also rules out passing because the child never called.
    expect(receivedAt).toBeTypeOf('number');
    expect(performance.now() - receivedAt!).toBeLessThan(3_500);
  }, 20_000);

  it('empty/whitespace injection text -> nothing emitted', async () => {
    const op = fakeOperator({ text: '   ' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });
});

/**
 * ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 * The operator acks a turn-start orientation block only when the next request
 * echoes the token it was delivered under, and the CLI records that token only
 * after its stdout write succeeded. Driven through the real subprocess because
 * "printed, then recorded" is a property of the process, not of dispatch().
 */
describe('turn-start delivery ledger (P-005)', () => {
  const turnStart = (env: Record<string, string>) =>
    runCli(['--client=claude', '--event=UserPromptSubmit'], JSON.stringify({ prompt: 'hi' }), env);
  const isolatedHome = () => mkdtempSync(path.join(tmpdir(), 'inject-ledger-'));

  it('echoes the token it printed on the NEXT turn, and nothing it did not print', async () => {
    const opts: { deliveryToken?: string; delayMs?: number } = { deliveryToken: 'tok-1' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-ledger', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };

    const first = await turnStart(env);
    expect(first.stdout).toContain('INJECTED');
    // Nothing provable yet: the key is present (opted in) and null.
    expect(op.received[0].body).toHaveProperty('confirmedDelivery', null);

    // This turn's answer lands after the 2.5s wall, so the hook prints nothing —
    // the exact case where the server staged tok-2 and arrival would have acked it.
    opts.deliveryToken = 'tok-2';
    opts.delayMs = 3_000;
    const killed = await turnStart(env);
    expect(killed.stdout).toBe('');
    expect(op.received[1].body.confirmedDelivery).toBe('tok-1');

    opts.delayMs = 0;
    await turnStart(env);
    expect(op.received[2].body.confirmedDelivery).toBe('tok-1');
  }, 20_000);

  it('records nothing when the response has nothing to print', async () => {
    const opts: { text?: string; deliveryToken?: string } = { text: '   ', deliveryToken: 'tok-silent' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-silent', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };

    await turnStart(env);
    await turnStart(env);
    expect(op.received[1].body.confirmedDelivery).toBeNull();
    expect(existsSync(path.join(env.PAPERCUSP_HOME, 'state', 'turn-start-delivery', 'sid-silent.emissions'))).toBe(false);
  });

  it('retains exact original emission proof across compaction and a new native turn', async () => {
    const owner = 'sid-carry-proof';
    const desired = { specificationRevision: '1'.repeat(64), stateRevision: '2'.repeat(64) };
    const applied = { ...desired, stateRevision: '3'.repeat(64) };
    const control = { targetOwnerId: owner, generation: 18, stateHash: '4'.repeat(64),
      state: { activation: { status: 'prepared', desired, prepared: desired, applied } } };
    const opts = { text: `⟦CTRL:transition⟧ ${JSON.stringify(control)}\n\nPRIVATE-CONTEXT`, deliveryToken: 'token-18' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: owner, PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };
    const turn = (native: string) => runCli(['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'measure', session_id: native }), env);
    const first = await turn('native-before');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('PRIVATE-CONTEXT');
    const receipts = path.join(env.PAPERCUSP_HOME, 'state', 'turn-start-delivery', `${owner}.emissions`);
    const originalPath = path.join(receipts, readdirSync(receipts)[0]);
    const original = readFileSync(originalPath, 'utf8');
    expect(JSON.parse(original)).toMatchObject({ token: 'token-18', stage: 'stdout-emitted',
      nativeSessionId: 'native-before', payloadSha256: createHash('sha256').update(first.stdout).digest('hex'),
      control: { generation: 18, desired, prepared: desired, applied } });
    expect(original).not.toContain('PRIVATE-CONTEXT');
    opts.deliveryToken = 'compaction-only-token';
    await runCli(['--client=codex', '--event=SessionStart'], JSON.stringify({ source: 'compact' }), env);
    expect(readdirSync(receipts)).toHaveLength(1);
    opts.deliveryToken = 'token-19';
    opts.text = `⟦CTRL:transition⟧ ${JSON.stringify({ ...control, generation: 19 })}\n\nSUCCESSOR`;
    const successor = await turn('native-after');
    expect(successor.code).toBe(0);
    expect(op.received[2].body.confirmedDelivery).toBe('token-18');
    expect(readFileSync(originalPath, 'utf8')).toBe(original);
    expect(readdirSync(receipts)).toHaveLength(2);
    expect(readFileSync(path.join(path.dirname(receipts), `${owner}.token`), 'utf8')).toBe('token-19');
    const newest = readdirSync(receipts).map(name => JSON.parse(readFileSync(path.join(receipts, name), 'utf8')))
      .find(receipt => receipt.token === 'token-19');
    expect(newest).toMatchObject({ nativeSessionId: 'native-after', control: { generation: 19 } });
  });

  it('mid-turn never carries a confirmation — the ledger is turn-start only', async () => {
    const op = fakeOperator({ deliveryToken: 'tok-mid' });
    const base = await op.start();
    running = op;
    await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({ tool_calls: [{ tool_name: 'B', tool_input: 'x', tool_response: 'y' }] }),
      { PAPERCUSP_SID: 'sid-mid', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() },
    );
    expect(op.received[0].body).not.toHaveProperty('confirmedDelivery');
  });

  it('an unwritable ledger keeps ack-on-arrival instead of proving nothing forever', async () => {
    const op = fakeOperator({ deliveryToken: 'tok-1' });
    const base = await op.start();
    running = op;
    // A regular FILE where the home directory should be: mkdir under it fails.
    const home = path.join(isolatedHome(), 'not-a-dir');
    writeFileSync(home, '');
    const res = await turnStart({ PAPERCUSP_SID: 'sid-ro', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: home });
    expect(res.stdout).toContain('INJECTED');
    expect(op.received[0].body).not.toHaveProperty('confirmedDelivery');
  });
});

describe('CONTROL — proves the assertions above can actually fail', () => {
  /**
   * Without this, every fail-silent assertion is satisfiable by a dispatcher
   * that does nothing at all, and a test suite that cannot distinguish a
   * working guard from a DELETED one is not a guard at all (P-007).
   *
   * These drive the SAME CLI with the SAME harness and assert the OPPOSITE
   * outcome, so if the fail-silent paths were removed — or if the runner were
   * silently not executing anything — the pair could not both hold.
   */
  it('a working path DOES produce stdout, so "empty stdout" is a real signal', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).not.toBe('');
    expect(res.stdout).toContain('additionalContext');
  });

  it('a NON-ZERO exit is observable by this harness, so "exit 0" is a real signal', async () => {
    // If runCli always reported 0 — a plausible bug in the helper — every
    // fail-silent test would pass against a dispatcher that crashes.
    const res = await new Promise<number>((resolve) => {
      const child = execFile(process.execPath, ['-e', 'process.exit(3)'], () => {});
      child.on('exit', (code) => resolve(code ?? -1));
    });
    expect(res).toBe(3);
  });

  it('the turn-start kill-switch is NOT suppress — catches a collapse to boolean', () => {
    // The specific regression: someone reads D-001's one-line summary, makes
    // both switches booleans, and turn-start stops delivering CTRL transitions.
    expect(ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' }).mode).not.toBe(
      'suppress',
    );
  });
});
