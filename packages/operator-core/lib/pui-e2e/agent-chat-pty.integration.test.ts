/**
 * Shipping-gate Agent Chat E2E (own-tui-full-divorce-2026-08-24 P-022).
 *
 * This is intentionally above the reducer/parser layer:
 *
 *   installed/built `pui` -> real PTY -> production Hono operator app ->
 *   real owned loop -> real migrated Postgres
 *
 * By default, the scripted peer replaces only the external engine protocol.
 * PUI_REAL_ENGINE=1 uses the actual maintained engine and an installed artifact.
 * SU bootstrap, engine translation, command execution, chat/session persistence,
 * HTTP/SSE transport and Ratatui UI stay real. Explicit transport faults exercise
 * acknowledgement loss and retry without spending provider credentials.
 */
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFile, fork, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Session as InspectorSession } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseSseStream } from '@papercusp/sse';
import type { ClaudeEngineOptions, ClaudeSuEngine } from '../su-session-claude-engine';
import type { SuRpcEngine } from '../su-session-rpc-engine';
import type { SuSessionCommand, SuSessionDescriptor, SuSessionEvent } from '@papercusp/chat-protocol';
import type { OrgTestDb } from '../../test/_org-test-db';
import { paneContains, screenContains, screenHasAssistantReply, VtScreen } from './vt-screen';
import { redactSensitiveText } from '../sensitive-text';
import { nativeProviderRequestSignal, nativeProviderTraceOrigin } from './native-provider-trace';
import { HARNESS_TAG } from './release-acceptance';

// A [sync-slow] line (resolve-observability.ts, 2s default) is a perf signal
// that load on the shared box trips at random; fail-on-console turned it into
// spurious functional failures of unrelated cases. Read before any import.
vi.hoisted(() => { process.env.PAPERCUSP_SYNC_SLOW_RESOLVE_MS ??= '60000'; });

const scriptedEngine = vi.hoisted(() => ({
  real: process.env.PUI_REAL_ENGINE === '1',
  backend: process.env.PUI_REAL_BACKEND ?? 'claude',
  mode: 'success' as 'success' | 'failure' | 'stall' | 'startup-exit' | 'question' | 'edit' | 'stream' | 'approval'
    | 'engine-death' | 'stream-loss' | 'auth-expired' | 'rate-limit',
  successText: 'PUI structured engine replied',
  // One entry per native launch: an exact resume names the dead native id in
  // `resume`; a fresh start names it in `sessionId`. The P-009 oracles read it.
  sdkSessions: [] as Array<{ resume: string | null; sessionId: string | null }>,
  // Approval fixture (mode:'approval'). TWO isolated requests, raised at once,
  // because both approval clauses are about ISOLATION: answering one must not
  // decide the other. A single-request probe cannot detect "hits an unrelated
  // session" or "affects a different request" at all.
  //
  // The commands are distinguishable on screen because the approval prompt
  // embeds the tool input verbatim (native-cards.ts:57), which is how a test
  // can tell WHICH request the PUI has focused without assuming an order.
  approvalRequests: [
    { tag: 'ALPHA', input: { command: 'echo PUI-APPROVAL-ALPHA' } as Record<string, unknown> },
    { tag: 'BETA', input: { command: 'echo PUI-APPROVAL-BETA' } as Record<string, unknown> },
  ],
  approvalVerdicts: [] as Array<{ tag: string; verdict: { behavior: string; updatedInput?: Record<string, unknown>; message?: string } }>,
  // Appended ONLY when a verdict actually authorises the call, carrying the
  // arguments as authorised — so "the denied action executed" and "allow
  // executed something broader" are both directly observable.
  approvalExecuted: [] as Array<{ tag: string; input: Record<string, unknown> }>,
  // Streaming fixture (mode:'stream'). Ordered, individually identifiable
  // chunks: asserting the exact concatenation then decides DROPPED and
  // REORDERED at once, which two separate "contains" checks could not.
  streamChunks: ['STREAM-A1 ', 'STREAM-B2 ', 'STREAM-C3 ', 'STREAM-D4 ', 'STREAM-E5'] as string[],
  // Slow enough that the draft edits below genuinely land mid-stream.
  streamDelayMs: 800,
  // File-editing fixture (mode:'edit'). The PUI resolves an Edit tool call into
  // a CHANGE CARD from these ARGUMENTS alone (change_card.rs::card_for_tool), so
  // the path deliberately need not exist on disk — the card is a view of the
  // proposed edit, not of the filesystem.
  editPath: 'apps/tui/src/pui_diff_probe.rs',
  editOld: 'fn probe() {\n    let kept = 1;\n    let dropped = 2;\n}',
  editNew: 'fn probe() {\n    let kept = 1;\n    let introduced = 3;\n}',
  // Inline-question fixture (mode:'question'). `questionCallId` is the TOOL
  // call id only. The card's correlationId is minted independently by
  // `registerCard` inside SuNativeCards (su-session-native-cards.ts:35), so a
  // test proves an answer reached the MATCHING waiting turn from the card
  // event's `turnId` and from the answers map keyed by the exact question
  // text — never by assuming the card is keyed by the tool call id.
  questionCallId: 'pui-question-tool',
  questionPrompt: 'Keep or change the draft title?',
  questionOptions: ['Keep', 'Change'] as string[],
  // What the engine's permission callback returned — i.e. what the answer
  // looked like by the time it got back to the model. This is the half that
  // decides "the answer was lost".
  questionVerdicts: [] as Array<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>,
  requests: [] as string[],
  sdkPermissions: [] as Array<{ mode: string | undefined; bypass: boolean | undefined }>,
  engines: [] as (ClaudeSuEngine | SuRpcEngine)[],
  events: [] as SuSessionEvent[],
  initialization: Promise.resolve(),
}));

// Observe real maintenance scheduling so the fixture can dispose its own
// timers before dropping their database. Production passes still run normally.
const maintenance = vi.hoisted(() => ({ jobs: [] as Array<{ stop(): Promise<void> }> }));
const nativeTerminalLaunch = vi.hoisted(() => vi.fn(() => {
  throw new Error('PUI attached sessions must never open a native agent terminal');
}));
vi.mock('../terminal-spawn', async (original) => ({
  ...await original<typeof import('../terminal-spawn')>(),
  spawnInTerminal: nativeTerminalLaunch,
}));
vi.mock('../session-end-lease-release-hook', async (original) => {
  const actual = await original<typeof import('../session-end-lease-release-hook')>();
  return { ...actual, scheduleSessionEndLeaseRelease(...args: Parameters<typeof actual.scheduleSessionEndLeaseRelease>) {
    const job = actual.scheduleSessionEndLeaseRelease(...args);
    maintenance.jobs.push(job);
    return job;
  } };
});
vi.mock('../session-archive-hook', async (original) => {
  const actual = await original<typeof import('../session-archive-hook')>();
  return { ...actual, async scheduleArchiveForAdvSession(...args: Parameters<typeof actual.scheduleArchiveForAdvSession>) {
    const job = await actual.scheduleArchiveForAdvSession(...args);
    if (job) maintenance.jobs.push(job);
    return job;
  } };
});

vi.mock('../su-session-claude-engine', async (original) => {
  const actual = await original<typeof import('../su-session-claude-engine')>();
  return {
    ...actual,
    startClaudeSuEngine(...args: Parameters<typeof actual.startClaudeSuEngine>) {
      if (scriptedEngine.real) {
        // Observe the production host; never supply a query, attach an adapter,
        // or send an owner turn from the fixture in the live-provider journey.
        const engine = actual.startClaudeSuEngine(args[0], args[1], args[2], args[3]);
        scriptedEngine.engines.push(engine);
        void (async () => {
          for await (const { event } of engine.adapter.host.subscribe()) {
            scriptedEngine.events.push(event);
          }
        })();
        return engine;
      }
      const query: NonNullable<ClaudeEngineOptions['query']> = ({ prompt, options: sdkOptions }) => {
        scriptedEngine.sdkPermissions.push({ mode: sdkOptions.permissionMode,
          bypass: sdkOptions.allowDangerouslySkipPermissions });
        scriptedEngine.sdkSessions.push({ resume: sdkOptions.resume ?? null, sessionId: sdkOptions.sessionId ?? null });
        // The real SDK launches the native CLI through this hook, and it is the
        // ONLY place the engine learns its pid (su-session-claude-engine.ts
        // `spawnClaudeCodeProcess`). Resume readiness refuses a null pid
        // ('Resume produced no native process'), so a fixture that never spawned
        // made every recovered engine fail at readiness. The stand-in keeps the
        // CLI's lifetime: it exits on stdin EOF (the SDK's graceful close) or on
        // the forwarded abort, and the death modes below kill it outright.
        const native = sdkOptions.spawnClaudeCodeProcess?.({
          command: process.execPath,
          args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
          cwd: args[0].cwd,
          env: Object.fromEntries(Object.entries(sdkOptions.env ?? process.env)
            .filter(([key]) => key !== 'NODE_OPTIONS')),
          signal: sdkOptions.abortController?.signal ?? new AbortController().signal,
        });
        // The SDK's process transport observes child errors; an abort-driven
        // kill emits one, and unobserved it escapes as an unhandled error.
        native?.on('error', () => {});
        const output = new PassThrough({ objectMode: true });
        let nativeId = '';
        // Real Claude appends every native line to its per-session JSONL as it
        // goes, and exact resume (su-session-resume.ts) requires that file. An
        // engine that never received the prompt leaves none.
        const configDir = sdkOptions.env?.CLAUDE_CONFIG_DIR;
        const persist = (line: Record<string, unknown>) => {
          if (!configDir || !nativeId) return;
          mkdirSync(path.join(configDir, 'projects', 'pui-e2e'), { recursive: true });
          appendFileSync(path.join(configDir, 'projects', 'pui-e2e', `${nativeId}.jsonl`),
            `${JSON.stringify({ ...line, sessionId: nativeId })}\n`);
        };
        const result = () => output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        void (async () => {
          for await (const message of prompt) {
            if (!message.session_id) throw new Error('The PUI engine must stamp a native session ID on every input');
            nativeId = message.session_id;
            scriptedEngine.requests.push(String(message.message.content));
            output.write({ type: 'system', subtype: 'init', session_id: nativeId, cwd: args[0].cwd });
            output.write(message); // The engine's exact native receipt.
            persist(message as unknown as Record<string, unknown>);
            if (scriptedEngine.mode === 'stall') {
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'text', text: 'PUI tool is still running' },
                { type: 'tool_use', id: 'pui-pending-tool', name: 'Bash', input: { command: 'sleep 30' } },
              ] } });
              continue;
            }
            if (scriptedEngine.mode === 'failure') {
              output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId,
                is_error: true, errors: ['PUI-E2E engine failed visibly'] });
              continue;
            }
            // P-009 terminal failures AFTER durable acceptance. Death and stream
            // loss end the native stream mid-turn (thrown vs clean EOF); expired
            // auth and a rate limit are the SDK's own form for an API refusal: a
            // `success` result with is_error and the API error text as `result`.
            if (scriptedEngine.mode === 'engine-death' || scriptedEngine.mode === 'stream-loss') {
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'text', text: 'PUI partial reply before the failure' },
              ] } });
              if (scriptedEngine.mode === 'engine-death') {
                native?.kill('SIGKILL');
                output.destroy(new Error('PUI-E2E engine process died mid-turn'));
              } else {
                native?.stdin.end();
                output.end();
              }
              return;
            }
            if (scriptedEngine.mode === 'auth-expired' || scriptedEngine.mode === 'rate-limit') {
              output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: true,
                result: scriptedEngine.mode === 'auth-expired'
                  ? 'API Error: 401 authentication_error: PUI-E2E OAuth token has expired · Please run /login'
                  : 'API Error: 429 rate_limit_error: PUI-E2E request would exceed the rate limit' });
              continue;
            }
            if (scriptedEngine.mode === 'approval') {
              // Tool-approval requests take the SAME permission callback as the
              // inline question above; `SuNativeCards.handleClaude` branches on
              // the tool NAME, and any name other than AskUserQuestion raises an
              // Approve/Decline card (native-cards.ts:56-62). Both requests are
              // fired together so both cards are open at once, which is the only
              // arrangement in which isolation is observable.
              void Promise.all(scriptedEngine.approvalRequests.map(({ tag, input }) =>
                // Each request carries its OWN `toolUseID`/`requestId` (both
                // required members of the permission context). Distinct ids per
                // request are what let the two open cards be told apart — the
                // isolation this case exists to observe.
                Promise.resolve(sdkOptions.canUseTool?.('Bash', input, {
                  signal: new AbortController().signal,
                  toolUseID: tag,
                  requestId: `${tag}-request`,
                }))
                  .then((verdict) => {
                    const settled = verdict ?? { behavior: 'no-permission-callback' };
                    scriptedEngine.approvalVerdicts.push({ tag, verdict: settled });
                    // The call runs ONLY on an authorising verdict, and runs the
                    // arguments the verdict returned — not the ones originally
                    // requested. That distinction is what makes "allow executes
                    // a BROADER action" detectable rather than assumed away.
                    if (settled.behavior === 'allow') {
                      scriptedEngine.approvalExecuted.push({ tag, input: settled.updatedInput ?? {} });
                    }
                  })))
                .then(() => {
                  output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                    { type: 'text', text: scriptedEngine.successText },
                  ] } });
                  result();
                }).catch((error: Error) => output.destroy(error));
              continue;
            }
            if (scriptedEngine.mode === 'stream') {
              // Real partial-message streaming, the path the adapter ingests at
              // su-session-claude-adapter.ts:512 (`stream_event` ->
              // content_block_delta/text_delta). The turn stays in flight across
              // several chunks so a test can edit the composer DURING it, which
              // is the situation AUTO-BAR-R-05 is about.
              output.write({ type: 'stream_event', session_id: nativeId,
                event: { type: 'message_start', message: { role: 'assistant', id: 'pui-stream-msg' } } });
              void (async () => {
                for (const chunk of scriptedEngine.streamChunks) {
                  await new Promise((resolve) => setTimeout(resolve, scriptedEngine.streamDelayMs));
                  output.write({ type: 'stream_event', session_id: nativeId,
                    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
                }
                // The canonical block must agree with what was streamed, or the
                // adapter's reconciliation (:538) would be papering over a
                // difference this clause exists to detect.
                output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                  { type: 'text', text: scriptedEngine.streamChunks.join('') },
                ] } });
                result();
              })().catch((error: Error) => output.destroy(error));
              continue;
            }
            if (scriptedEngine.mode === 'edit') {
              // A file-editing tool call. The PUI resolves this into the in-PUI
              // scrollable change card (PUBLIC_RELEASE_UX.md:375) that
              // PUI-TOOLS-DIFF is about, straight from these arguments.
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'tool_use', id: 'pui-e2e-edit', name: 'Edit', input: {
                  file_path: scriptedEngine.editPath,
                  old_string: scriptedEngine.editOld,
                  new_string: scriptedEngine.editNew,
                } },
              ] } });
              output.write({ type: 'user', session_id: nativeId, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'pui-e2e-edit', content: 'edit applied' },
              ] } });
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'text', text: scriptedEngine.successText },
              ] } });
              result();
              continue;
            }
            if (scriptedEngine.mode === 'question') {
              // An inline question, left OPEN: the turn must park until the owner
              // answers, which is the state PUI-QUESTION is about.
              //
              // ⚠ The card does NOT come from this tool_use. The engine pins
              // `cardSource: 'transport'` (su-session-claude-engine.ts:187), so
              // the adapter's transcript -> card branch is gated off at
              // su-session-claude-adapter.ts:630 (`!this.transportHandlesCards`)
              // and emitting an `AskUserQuestion` tool_use ALONE produces no card
              // whatsoever — a silent nothing rather than an error, which is
              // exactly how this reads as "the fixture cannot do questions".
              //
              // The live provider's questions arrive over the SDK permission
              // callback the engine installs (su-session-claude-engine.ts:265),
              // which routes into `SuNativeCards.handleClaude` and mints the card
              // there. So the fixture emits BOTH halves, as the real provider
              // does: the transcript tool_use (observable as a `tool` event) and
              // the permission callback (observable as a `card` event). Driving
              // the callback means this case exercises the production card code
              // end to end rather than a fixture re-implementation of it.
              const questions = [{
                question: scriptedEngine.questionPrompt,
                options: scriptedEngine.questionOptions.map((label) => ({ label })),
                multiSelect: false, // -> presentation.kind 'radio' (true would give 'checkbox')
              }];
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'tool_use', id: scriptedEngine.questionCallId, name: 'AskUserQuestion', input: { questions } },
              ] } });
              // `signal`, `toolUseID` and `requestId` are the required members
              // of the permission context; handleClaude reads nothing else on
              // the AskUserQuestion path. `toolUseID` is deliberately the SAME
              // id as the tool_use emitted just above — that is how the real
              // provider correlates the two halves, so the fixture must too.
              const controller = new AbortController();
              void Promise.resolve(sdkOptions.canUseTool?.('AskUserQuestion', { questions }, {
                signal: controller.signal,
                toolUseID: scriptedEngine.questionCallId,
                requestId: `${scriptedEngine.questionCallId}-request`,
              }))
                .then((verdict) => {
                  scriptedEngine.questionVerdicts.push(verdict ?? { behavior: 'no-permission-callback' });
                  const answers = verdict && 'updatedInput' in verdict
                    ? (verdict.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {} : {};
                  // Only now does the turn finish: the owner's answer is what
                  // un-parks it, which is the half a test cannot see from the
                  // card events alone.
                  output.write({ type: 'user', session_id: nativeId, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: scriptedEngine.questionCallId, content: JSON.stringify(answers) },
                  ] } });
                  output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                    { type: 'text', text: scriptedEngine.successText },
                  ] } });
                  result();
                }).catch((error: Error) => output.destroy(error));
              continue;
            }
            output.write({ type: 'assistant', session_id: nativeId, message: { content: [
              { type: 'tool_use', id: 'pui-e2e-tool', name: 'Read', input: { file_path: 'README.md' } },
            ] } });
            output.write({ type: 'user', session_id: nativeId, message: { role: 'user', content: [
              { type: 'tool_result', tool_use_id: 'pui-e2e-tool', content: 'scripted engine tool result' },
            ] } });
            output.write({ type: 'assistant', session_id: nativeId, message: { content: [
              { type: 'text', text: scriptedEngine.successText },
            ] } });
            result();
          }
        })().catch((error: Error) => output.destroy(error));
        return {
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          initializationResult: async () => {
            await scriptedEngine.initialization;
            if (scriptedEngine.mode === 'startup-exit') {
              native?.kill('SIGKILL');
              output.end();
              throw new Error('PUI-E2E engine exited during initialization');
            }
            return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] };
          },
          mcpServerStatus: async () => [{ name: 'papercusp-su', status: 'connected' as const }],
          interrupt: async () => { result(); },
          close: () => { native?.stdin.end(); output.end(); },
        };
      };
      const engine = actual.startClaudeSuEngine(args[0], args[1], args[2], { ...args[3], query });
      scriptedEngine.engines.push(engine);
      // Observe host events for the SCRIPTED engine too. Without this,
      // `scriptedEngine.events` stays empty off the real-engine path, so
      // `pendingNativeCards()` can only ever return [] and every card-mediated
      // behaviour looks unsupported when it is merely UNOBSERVED — the adapter
      // emits those cards perfectly well (su-session-claude-adapter.ts:630).
      // The rpc mock below has always subscribed unconditionally; this is the
      // same line, and the asymmetry was an oversight rather than a design.
      void (async () => {
        for await (const { event } of engine.adapter.host.subscribe()) scriptedEngine.events.push(event);
      })();
      return engine;
    },
  };
});

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');

vi.mock('../su-session-rpc-engine', async (original) => {
  const actual = await original<typeof import('../su-session-rpc-engine')>();
  return { ...actual, startSuRpcEngine(...args: Parameters<typeof actual.startSuRpcEngine>) {
    const engine = actual.startSuRpcEngine(args[0], args[1], args[2]);
    scriptedEngine.engines.push(engine);
    void (async () => {
      for await (const { event } of engine.adapter.host.subscribe()) scriptedEngine.events.push(event);
    })();
    return engine;
  } };
});
const HARNESS = 'papercusp';
const WORKSPACE = 'pui-agent-chat-e2e';
const OWNER = 'pui-agent-chat-e2e-owner';
const REAL_PLAN = 'pui-native-acceptance-plan';
const REAL_APPROVAL_WORK_ITEM = 'EI-90000006';
const execFileAsync = promisify(execFile);

// Opt-in diagnosis uses the actual worker (including cold module evaluation),
// preserves every console warning, and writes no request bodies or credentials.
const timingTrace: Array<Record<string, unknown>> = [];
const namedQueryRequests: string[] = [];
const namedQueryReplies: Array<{ name: string; status: number }> = [];
const pipelineCellRequests: string[] = [];
const PIPELINE_CELLS = new Set([
  'gate.greenCheckpoint.verdict', 'gate.greenCheckpoint.candidate',
  'git.mainBehindStaging', 'deploy.3070.sha',
]);
let timingInspector: InspectorSession | undefined;
let timingInterval: ReturnType<typeof setInterval> | undefined;
let timingScan: Promise<void> | undefined;
function traceTiming(kind: string, fields: Record<string, unknown> = {}): void {
  if (process.env.PUI_TIMING_DIR && timingTrace.length < 20_000) {
    timingTrace.push({ atMs: performance.now(), kind, ...fields });
  }
}
function profileCommand(method: string): Promise<unknown> {
  return new Promise((resolve, reject) => timingInspector!.post(method, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  }));
}

async function startTimingProfile(): Promise<void> {
  if (!process.env.PUI_TIMING_DIR) return;
  timingInspector = new InspectorSession();
  timingInspector.connect();
  await profileCommand('Profiler.enable');
  await profileCommand('Profiler.start');
  traceTiming('profile-start', { timeOriginMs: performance.timeOrigin });
  const diagnostics = await import('../../../../libs/papercusp/libs/db/src/acquire-registry');
  let expected = performance.now() + 25;
  let lastScan = 0;
  timingInterval = setInterval(() => {
    const now = performance.now();
    if (now - expected > 100) traceTiming('event-loop-delay', { delayMs: now - expected });
    expected = now + 25;
    if (!timingScan && now - lastScan >= 250) {
      lastScan = now;
      timingScan = (async () => {
        const active = await db.adminSql`
          SELECT pid, application_name, state, wait_event_type, wait_event,
                 EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000 AS age_ms,
                 pg_blocking_pids(pid) AS blockers, query
            FROM pg_stat_activity
           WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
        `;
        traceTiming('database', {
          // The shared diagnostic writer strips SQL literals and parameters.
          active: active.map(({ query, ...row }) => ({ ...row, family: diagnostics.pgQueryFamily(String(query)) })),
          pool: diagnostics.acquireSnapshot('org-admin'),
          results: diagnostics.pgResultDiagnosticSnapshot('org-admin').results,
        });
      })().catch((error: { code?: string }) => traceTiming('database-error', { code: error.code }))
        .finally(() => { timingScan = undefined; });
    }
  }, 25);
}

afterAll(async () => {
  if (!timingInspector) return;
  if (timingInterval) clearInterval(timingInterval);
  await timingScan;
  const { profile } = await profileCommand('Profiler.stop') as { profile: unknown };
  traceTiming('profile-stop');
  timingInspector.disconnect();
  mkdirSync(process.env.PUI_TIMING_DIR!, { recursive: true });
  writeFileSync(path.join(process.env.PUI_TIMING_DIR!, `worker-${process.pid}.json`),
    JSON.stringify({ trace: timingTrace, profile }));
});

function cargoTargetDir(): string | null {
  const probe = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  try {
    return (JSON.parse(probe.stdout) as { target_directory?: string }).target_directory ?? null;
  } catch {
    return null;
  }
}

/** PUI_BIN explicitly selects an installed artifact; otherwise use this build. */
function resolvePuiBinary(): string | null {
  const target = cargoTargetDir();
  const candidates = [
    process.env.PUI_BIN,
    target ? path.join(target, 'debug', 'pui') : null,
    target ? path.join(target, 'release', 'pui') : null,
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
    path.join(TUI_DIR, 'target', 'release', 'pui'),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function ensurePuiBinary(): string {
  if (scriptedEngine.real && !process.env.PUI_BIN) {
    throw new Error('PUI_REAL_ENGINE requires PUI_BIN from the supported install-update.sh installer');
  }
  if (process.env.PUI_BIN) {
    if (!existsSync(process.env.PUI_BIN)) throw new Error('The explicit PUI_BIN artifact does not exist');
    return process.env.PUI_BIN;
  }
  const built = spawnSync('cargo', ['build', '--locked', '--bin', 'pui'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 840_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (built.status !== 0) {
    throw new Error(`cargo build --locked --bin pui failed:\n${built.stderr?.slice(-4_000)}`);
  }
  const resolved = resolvePuiBinary();
  if (!resolved) throw new Error('pui binary is absent after a successful cargo build');
  return resolved;
}

class PuiPane {
  readonly pty: IPty;
  private raw = '';
  private exit: Promise<{ exitCode: number; signal?: number }>;
  private cols: number;
  private rows: number;
  private setupDriverArmed = false;
  private setupDriverRunning = false;
  private setupDriverError: unknown;
  // A real engine asks before the SU's own papercusp-su writes (D-021); each
  // wait answers a visible request as an owner would. Scripted engines never ask.
  private readonly suToolApprovals: string[] | undefined = scriptedEngine.real ? [] : undefined;
  private suToolApprovalAt = 0;
  // A native read outside the session's working directory asks the owner too;
  // only a card naming a path a journey registered is approved, and only once.
  private readonly nativeReadPaths = new Set<string>();
  private readonly nativeReadApprovals: string[] = [];

  /** SU tool approvals this pane answered, in order. */
  get answeredSuToolApprovals(): readonly string[] { return this.suToolApprovals ?? []; }

  /** Native file-read approvals this pane answered, as `<tool> <path>`. */
  get answeredNativeReadApprovals(): readonly string[] { return this.nativeReadApprovals; }

  /** Let a real engine's native read of `filePath` through its approval card. */
  approveNativeReadOf(filePath: string): void { this.nativeReadPaths.add(filePath); }

  /** Answer a visible papercusp-su approval card: the remembered choice when
   * the card offers one, otherwise Approve once. A native read of a registered
   * path is approved once. True when a key was sent. */
  settleSuToolApproval(): boolean {
    if (!this.suToolApprovals || Date.now() - this.suToolApprovalAt < 750) return false;
    const lines = this.screen().split('\n').map((line) => line.replace(/[│┌┐└┘─]/g, ' ').trim());
    const tool = lines.map((line) => /^Allow (mcp__papercusp-su__[\w-]+)\?/.exec(line)?.[1]).find(Boolean);
    const readAt = tool ? -1 : lines.findIndex((line) => /^Allow (Read|Grep|Glob)\?/.test(line));
    const readPath = readAt < 0 ? undefined
      : [...this.nativeReadPaths].find((p) => lines.slice(readAt + 1, readAt + 4).some((line) => line.includes(p)));
    if (!tool && !readPath) return false;
    const option = (label: string) => lines.map((line) => new RegExp(`^(?:› )?(\\d)\\. ${label}\\b`).exec(line)?.[1]).find(Boolean);
    const pick = readPath ? option('Approve') : option('Always allow') ?? option('Approve');
    if (!pick) return false;
    this.pty.write(pick);
    if (tool) this.suToolApprovals.push(tool);
    else this.nativeReadApprovals.push(`${/^Allow (\w+)\?/.exec(lines[readAt])?.[1]} ${readPath}`);
    this.suToolApprovalAt = Date.now();
    return true;
  }

  /** Existing conversation tests explicitly drive the new pre-send setup
   * through real keys. Dedicated onboarding cases leave this disabled so
   * they can inspect every step and its no-launch boundary themselves. */
  reviewNextNewSession(): void { this.setupDriverArmed = true; }

  constructor(
    bin: string,
    operatorPort: number,
    home: string,
    options: {
      args?: string[]; cols?: number; rows?: number; operatorToken?: string; env?: Record<string, string>;
      /** Never answer terminal queries, like a bare pipe (P-013 startup progress). */
      silentTerminal?: boolean;
    } = {},
  ) {
    this.cols = options.cols ?? 150;
    this.rows = options.rows ?? 44;
    this.pty = ptySpawn(bin, options.args ?? [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm-256color',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PUI_OPERATOR: `http://127.0.0.1:${operatorPort}`,
        ...(options.operatorToken ? { PUI_OPERATOR_TOKEN: options.operatorToken } : {}),
        ...options.env,
        PAPERCUSP_TUI_OWNER: OWNER,
        // Keep this direct-PTY test out of any ambient zellij/tmux session.
        ZELLIJ: '',
        ZELLIJ_SESSION_NAME: '',
        TMUX: '',
      },
    });
    this.pty.onData((chunk) => {
      this.raw += chunk;
      // Answer primary device attributes as a VTE-class terminal without the
      // kitty keyboard protocol does. PUI's startup capability probe
      // (crossterm supports_keyboard_enhancement, main.rs) waits up to 2 s for
      // this reply: every mainstream terminal answers at once, a bare PTY never.
      if (!options.silentTerminal && /\u001b\[0?c/.test(chunk)) this.pty.write('\u001b[?62;22c');
      if (this.setupDriverArmed && !this.setupDriverRunning
        && this.screen().includes('New SU session')) {
        this.setupDriverArmed = false;
        this.setupDriverRunning = true;
        void completeNewSessionSetup(this).catch((error) => {
          this.setupDriverError = error;
        }).finally(() => { this.setupDriverRunning = false; });
      }
    });
    this.exit = new Promise((resolve) => this.pty.onExit(resolve));
  }

  screen(): string {
    if (this.setupDriverError) throw this.setupDriverError;
    const vt = new VtScreen(this.rows, this.cols);
    vt.feed(this.raw);
    return vt.text();
  }

  /** The raw PTY stream from `offset` on, escapes included — what a terminal
   *  receives. P-013 reads its SGR sequences and replays it incrementally. */
  rawSince(offset = 0): string {
    return this.raw.slice(offset);
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  /**
   * Every OSC 52 clipboard write this TUI has emitted into the PTY, decoded.
   *
   * This is the real clipboard payload rather than a rendering of it: `pui`
   * copies by writing `ESC ] 52 ; c ; <base64> BEL` to the terminal
   * (`chat_copy::osc52`), so the exact bytes a terminal would place on the
   * system clipboard are observable here with no display server and no
   * shelled-out helper. Reading the rendered screen could not decide the
   * clipboard question at all — the screen is escape-formatted by
   * construction, so it cannot distinguish "the copy carries plain text" from
   * "the copy carries the escapes that drew it".
   *
   * The tmux/screen passthrough envelopes wrap this same inner sequence, so
   * the capture keeps working if the fixture ever runs under a multiplexer.
   */
  clipboardWrites(): string[] {
    const writes: string[] = [];
    const osc52 = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
    for (const match of this.raw.matchAll(osc52)) {
      writes.push(Buffer.from(match[1], 'base64').toString('utf8'));
    }
    return writes;
  }

  failureEvidence(): Record<string, unknown> {
    return {
      screen: this.screen(),
      traffic: sessionTraffic,
      commands: commandPosts.map(({ type, commandId }) => ({ type, commandId })),
      commandReplies,
      nativeFrames: nativeFrameDiagnostics,
      engines: scriptedEngine.engines.map((engine) => {
        const descriptor = engine.adapter.host.descriptor();
        return { pid: engine.pid(), identity: descriptor.identity, lifecycle: descriptor.lifecycle,
          diagnostics: engine.adapter.host.recent.map(({ event }) => event)
            .filter((event) => event.type === 'error' || event.type === 'lifecycle' || event.type === 'command_result')
            .slice(-20),
        };
      }),
    };
  }

  write(keys: string): void {
    this.pty.write(keys);
  }

  /** Crossterm's raw-mode Enter encoding (its parser fixture: CSI 13 u). */
  enter(): void {
    this.pty.write('\x1b[13u');
  }

  /** Crossterm's raw-mode Escape encoding (its parser fixture: CSI 27 u). */
  escape(): void {
    this.pty.write('\x1b[27u');
  }

  interrupt(): void {
    this.pty.write('\x1b[120;5u');
  }

  async waitFor(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (screenContains(this.screen(), needle)) return;
      this.settleSuToolApproval();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} on the rendered screen:\n` + this.screen(),
      { cause: new Error(`Production session evidence: ${JSON.stringify({ binary: bin, binarySha256, traffic: sessionTraffic })}`) },
    );
  }

  /**
   * Wait for a needle to LEAVE the rendered screen.
   *
   * The positive `waitFor` is the WRONG instrument for an undo or a clear,
   * because the text left behind is normally a PREFIX of the text being undone:
   * waiting for the restored draft is satisfied by the un-undone line that
   * still contains it, returns instantly, and samples the screen before the app
   * has even processed the key. The assertion that follows then passes or fails
   * for reasons having nothing to do with the feature. Wait for the DISAPPEARANCE
   * instead — that is the condition the behaviour actually claims.
   */
  async waitForGone(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!screenContains(this.screen(), needle)) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} to LEAVE the rendered screen:\n` + this.screen(),
      { cause: new Error(`Production session evidence: ${JSON.stringify({ binary: bin, binarySha256, traffic: sessionTraffic })}`) },
    );
  }

  async waitForReply(needle: string | RegExp): Promise<void> {
    try {
      await vi.waitFor(() => {
        // Match the rendered assistant bubble itself. History can scroll the
        // echoed owner request away (especially after a long interrupted reply),
        // and a context-dependent answer need not occur in the request at all.
        this.settleSuToolApproval();
        expect(screenHasAssistantReply(this.screen(), needle)).toBe(true);
      }, { timeout: 120_000, interval: 100 });
    } catch (cause) {
      const engineState = scriptedEngine.engines.map((engine) => ({ pid: engine.pid(),
        lifecycle: engine.adapter.host.descriptor().lifecycle,
        diagnostics: engine.adapter.host.recent.map(({ event }) => event)
          .filter((event) => event.type === 'error' || event.type === 'lifecycle'),
      }));
      throw new Error(`Correlated reply was not rendered:\n${this.screen()}\nProduction traffic: ${JSON.stringify(sessionTraffic)}\nEngine state: ${JSON.stringify(engineState)}`, { cause });
    }
    await this.waitFor('Message — Enter send', { timeoutMs: 120_000 });
  }

  async stop(): Promise<void> {
    try {
      this.pty.write('q');
    } catch {
      /* exited */
    }
    const graceful = await Promise.race([
      this.exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (!graceful) {
      try {
        this.pty.kill();
      } catch {
        /* exited */
      }
      await Promise.race([
        this.exit,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pui PTY did not exit')), 5_000)),
      ]);
    }
    await waitForNoChildren(this.pty.pid);
  }
}

async function processRows(args: string[]): Promise<string> {
  try {
    return (await execFileAsync('ps', args, { encoding: 'utf8' })).stdout;
  } catch (error) {
    // ps uses 1 for an empty selection (including a process that just exited).
    if ((error as { code?: number }).code === 1) return '';
    throw error;
  }
}

async function childPids(parent: number): Promise<number[]> {
  const rows = await processRows(['-o', 'pid=', '--ppid', String(parent)]);
  return rows
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForNoChildren(parent: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await childPids(parent)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  expect(await childPids(parent), `processes leaked below pui pid ${parent}`).toEqual([]);
}

async function listen(server: ServerType): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ServerType | undefined): Promise<void> {
  if (!server) return;
  if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function putViewState(tab: string): Promise<void> {
  const { putViewState: put } = await import('../tui-workbench-store');
  await put(OWNER, { tab, harness: HARNESS, operator_dock_open: false,
    ...(scriptedEngine.real && process.env.PUI_REAL_PLAN === '1' ? { plan_filter: [REAL_PLAN] } : {}) });
}

type PersistedChat = {
  id: string;
  role: string;
  transcript: Array<{ role: string; content: string; error?: boolean; su_command?: { command: SuSessionCommand; outcome?: unknown } }>;
};

async function persistedChats(db: OrgTestDb): Promise<PersistedChat[]> {
  return db.adminSql<PersistedChat[]>`
    SELECT id, role, transcript
    FROM harness_shared.agent_chats_consolidated
    WHERE workspace_id = ${WORKSPACE}
    ORDER BY updated_at DESC
  `;
}

type SeedAgentChat = {
  id: string;
  title: string;
  transcript: Array<Record<string, unknown>>;
  role?: string;
  featureId?: string | null;
  runtimeClass?: 'su-session' | 'legacy-owned-loop' | null;
  harness?: string;
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
  createdAt?: number;
  updatedAt?: number;
};

/** Seed a real Agent Chat row in this fixture's migrated Postgres database. */
async function seedAgentChat(input: SeedAgentChat): Promise<void> {
  const now = input.updatedAt ?? Date.now();
  await db.adminSql`
    INSERT INTO harness_shared.agent_chats_consolidated
      (workspace_id, harness_slug, id, role, feature_id, title, transcript,
       total_input_tokens, total_output_tokens, total_cost_usd_cents,
       created_at, updated_at, su_runtime_class)
    VALUES
      (${WORKSPACE}, ${input.harness ?? HARNESS}, ${input.id}, ${input.role ?? 'operator'},
       ${input.featureId ?? null}, ${input.title}, ${JSON.stringify(input.transcript)}::text::jsonb,
       ${input.inputTokens ?? 0}, ${input.outputTokens ?? 0}, ${input.costCents ?? 0},
       ${input.createdAt ?? now}, ${now}, ${input.runtimeClass ?? null})`;
}

/** Publish seeded Agent Chat transcript rows through the real sessions index. */
async function ingestSeededAgentChats(): Promise<void> {
  const { FILE_ADAPTERS, runSessionIngestOnce } = await import('../search/session-ingest');
  // Runtime home overrides protect the writers, not this indexer's homedir-
  // based readers. Keep the production sweep/SQL intact, but bind its file
  // inputs to this fixture so it never ingests the developer's real history.
  const roots = FILE_ADAPTERS.map((adapter) => {
    const root = path.join(home, 'indexed-native-history', adapter.sourceKind);
    mkdirSync(root, { recursive: true });
    return vi.spyOn(adapter, 'roots').mockReturnValue([{ root, dirDepth: 0 }]);
  });
  try {
    const stats = await runSessionIngestOnce();
    expect(stats.skipped).toBeUndefined();
    expect(stats.errors, JSON.stringify(stats)).toBe(0);
    expect(stats.filesScanned, 'fixture must not scan host-native sessions').toBe(0);
    expect(stats.chatsIngested, 'both seeded two-turn chats must be indexed').toBe(4);
  } finally {
    for (const root of roots) root.mockRestore();
  }
}

async function waitForPersistedChat(
  db: OrgTestDb,
  predicate: (chat: PersistedChat) => boolean,
  timeoutMs = 15_000,
): Promise<PersistedChat> {
  const deadline = Date.now() + timeoutMs;
  let last: PersistedChat[] = [];
  while (Date.now() < deadline) {
    last = await persistedChats(db);
    const chat = last.find(predicate);
    if (chat) return chat;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`timed out waiting for persisted Agent Chat state; last rows: ${JSON.stringify(last)}`);
}

let db: OrgTestDb;
let bin: string;
let binarySha256: string;
let home: string;
let operatorServer: ServerType;
let operatorPort: number;
let previousEnv: Record<string, string | undefined>;
let sessionTraffic: Array<Record<string, unknown>> = [];
let launchRequests: unknown[] = [];
let attachedCapability: 'current' | 'missing' | 'disabled' | 'unsafe' = 'current';
type TransportFault = 'none' | 'startup-disconnect' | 'refuse' | 'lost-ack' | 'wrong-command-ack' | 'wrong-session-ack';
let transportFault: TransportFault = 'none';
let commandPosts: SuSessionCommand[] = [];
let commandReplies: Array<{ status: number; replayed?: boolean }> = [];
let cardReplies: Array<{ path: string; status: number }> = [];
let initializeWarnings: Array<Record<string, unknown>> = [];
let optionalMemoryWarnings: string[] = [];
let configurationWarnings: string[] = [];
let intentPivotWarnings: string[] = [];
let timeoutDegradations: string[] = [];
let nativeFrameDiagnostics: Array<Record<string, unknown>> = [];
let readOmpDiagnosticState: (() => Promise<Record<string, unknown>>) | undefined;
let nativeProviderOrigin: string | undefined;
const nativeProviderEvents: Array<Record<string, unknown>> = [];

/**
 * Node IPC preserves JSON nulls even when the launch request used null as the
 * wire representation for an omitted optional field. The fixture's response
 * records use optional properties, so restore semantic absence at this reader
 * boundary instead of making each acceptance assertion know about transport
 * normalization.
 */
function normalizeIpcOptionalLaunchField(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

test('PUI IPC launch metadata restores omitted optional fields from JSON null', () => {
  expect(normalizeIpcOptionalLaunchField(null)).toBeUndefined();
  expect(normalizeIpcOptionalLaunchField(undefined)).toBeUndefined();
  expect(normalizeIpcOptionalLaunchField('auto')).toBe('auto');
});

// Drop command frames only for deliberate acknowledgement-loss cases. All other
// production SSE events still traverse the real HTTP connection to the PTY.
function withoutCommandReceipts(response: Response): Response {
  if (!response.body) throw new Error('production event stream has no body');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data && JSON.parse(data).type === 'command_result') continue;
        controller.enqueue(encoder.encode(frame + '\n\n'));
      }
    },
    flush(controller) { if (pending) controller.enqueue(encoder.encode(pending)); },
  })), { status: response.status, headers: response.headers });
}

async function openAgentChat(pane: PuiPane): Promise<void> {
  // The footer exists on every loaded tab. `o` is the global Agent Chat
  // action; leave an automatically restored composer before invoking it.
  await pane.waitFor('· pui ·', { timeoutMs: 40_000 });
  if (scriptedEngine.real && process.env.PUI_REAL_PLAN === '1') {
    // View-state restoration is asynchronous and any owner key deliberately
    // cancels a still-pending restore. The Plans header proves the seeded
    // state (including its singleton plan_filter) reached the reducer before
    // this fixture sends Escape/o and asks PUI for launch options.
    await pane.waitFor('Plans (', { timeoutMs: 40_000 });
  }
  pane.escape();
  pane.write('o');
  await pane.waitFor('┌ Agent Chat');
}

async function completeNewSessionSetup(pane: PuiPane): Promise<void> {
  await pane.waitFor('New SU session — 1 Context');
  pane.write('/');
  pane.write(HARNESS);
  pane.enter(); // finish search, not a launch
  await pane.waitFor(`> ${HARNESS}`);
  pane.enter(); // explicitly choose this project's stable identity
  await pane.waitFor('New SU session — 2 Runtime');
  await pane.waitFor('Runtime: Ready', { timeoutMs: 45_000 });
  pane.enter();
  await pane.waitFor('New SU session — 3 Review');
  pane.enter(); // sole launch action
}

async function openComposer(pane: PuiPane, reviewNewSession = true): Promise<void> {
  await openAgentChat(pane);
  await pane.waitFor(`pot ${HARNESS} · role operator · session new`);
  pane.escape();
  await pane.waitFor('i type · v speak');
  if (scriptedEngine.real && scriptedEngine.backend !== 'claude') {
    const selection = ['claude', 'codex', 'omp'].indexOf(scriptedEngine.backend);
    if (selection < 0) throw new Error(`Unknown PUI_REAL_BACKEND: ${scriptedEngine.backend}`);
    pane.write('b');
    await pane.waitFor('Backend — Enter select');
    pane.write('j'.repeat(selection));
    pane.enter();
    await pane.waitFor(`backend ${['Claude', 'Codex', 'OMP'][selection]}`);
  }
  if (scriptedEngine.real && process.env.PUI_REAL_ACCOUNT) {
    const account = process.env.PUI_REAL_ACCOUNT;
    if (!['auto', 'default'].includes(account)) throw new Error('PUI_REAL_ACCOUNT must be auto or default');
    pane.write('a');
    await pane.waitFor('Account route — Enter select');
    if (account === 'default') pane.write('j');
    pane.enter();
    await pane.waitFor(`account ${account}`);
  }
  if (scriptedEngine.real && process.env.PUI_REAL_MODEL) {
    const model = process.env.PUI_REAL_MODEL;
    pane.write('m');
    await pane.waitFor('Model — Enter select');
    await pane.waitFor(model);
    // The fixture installs one exact valid tier after the inherit row.
    pane.write('j');
    pane.enter();
    await pane.waitFor(`model ${model}`);
  }
  if (scriptedEngine.real && process.env.PUI_REAL_MODE) {
    const mode = process.env.PUI_REAL_MODE;
    if (mode !== 'auto') throw new Error('PUI_REAL_MODE acceptance currently supports only auto');
    pane.write('u');
    await pane.waitFor('Launch mode — Enter select');
    await pane.waitFor('AUTO — act');
    pane.write('j');
    pane.enter();
    await pane.waitFor(`mode ${mode}`);
  }
  pane.write('i');
  if (reviewNewSession) pane.reviewNextNewSession();
}

async function waitForSavedTurn(content: string): Promise<PersistedChat> {
  try {
    return await waitForPersistedChat(db, (candidate) => {
      if (candidate.transcript.some((turn) => turn.role === 'user' && turn.content === content)) return true;
      if (!scriptedEngine.real) return false;
      const refusedLaunch = sessionTraffic.find((entry) => entry.path === '/api/adv/sessions/launch-su' && Number(entry.status) >= 400);
      if (refusedLaunch) throw new Error(`Native launch refused: ${String(refusedLaunch.error ?? refusedLaunch.status)}`);
      // A resumed conversation deliberately retains its stopped predecessor in
      // the evidence list. Only the current native process can refuse this turn.
      const active = scriptedEngine.engines.at(-1);
      if (active?.adapter.host.snapshot().terminal) {
        const diagnostics = active.adapter.host.recent.map(({ event }) => event)
          .filter((event) => event.type === 'error' || event.type === 'lifecycle').slice(-5);
        throw new Error(`Native engine stopped before the owner turn was saved: ${JSON.stringify(diagnostics)}`);
      }
      return false;
    }, scriptedEngine.real ? 120_000 : 15_000);
  } catch (error) {
    const active = scriptedEngine.engines.at(-1)?.adapter.host;
    throw new Error(`Agent Chat turn was not saved: ${JSON.stringify({
      traffic: sessionTraffic,
      commandTypes: commandPosts.map((command) => command.type),
      lifecycle: active?.descriptor().lifecycle,
      terminal: active?.snapshot().terminal,
      recent: active?.recent.map(({ event }) => event)
        .filter((event) => event.type === 'error' || event.type === 'lifecycle').slice(-5),
    })}`, { cause: error });
  }
}

async function waitForCorrelatedReply(
  prompt: string,
  reply: string | RegExp,
  events: SuSessionEvent[] = scriptedEngine.events,
): Promise<PersistedChat> {
  // The chat table stores accepted command receipts. Assistant text belongs to
  // the native transcript, exposed through the real adapter's SU event stream.
  const chat = await waitForSavedTurn(prompt);
  const command = chat.transcript.find((turn) => turn.content === prompt)?.su_command?.command;
  if (command?.type !== 'owner_turn') throw new Error('Greeting/follow-up lacks a durable owner-turn receipt');
  await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'transcript', phase: 'completed', role: 'assistant', channel: 'text',
      content: typeof reply === 'string' ? reply : expect.stringMatching(reply),
      turnId: command.turnId, session: command.target,
    }),
  ])), { timeout: 120_000, interval: 100 });
  return chat;
}

async function finishTeardown(steps: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'PUI fixture teardown failed');
}

async function stopEngines(): Promise<void> {
  await finishTeardown(scriptedEngine.engines.splice(0).flatMap((engine) => {
    // The protocol peer has no native CLI lifecycle hook. Remove only its
    // bootstrap presence in this isolated DB before the real close/reaper runs.
    const owner = engine.adapter.host.descriptor().identity.ownerId;
    return [
      async () => {
        if (!scriptedEngine.real) {
          await db.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${owner}`;
        }
      },
      () => engine.close(),
      () => engine.adapter.dispose(),
    ];
  }));
}


beforeAll(async () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  bin = ensurePuiBinary();
  binarySha256 = createHash('sha256').update(readFileSync(bin)).digest('hex');
  home = mkdtempSync(path.join(tmpdir(), 'pui-agent-chat-e2e-'));
  mkdirSync(path.join(home, '.papercusp'), { recursive: true });
  writeFileSync(path.join(home, '.papercusp', 'pui-state.json'), JSON.stringify({ tutorialSeen: true }));

  const routedAccount = scriptedEngine.real && process.env.PUI_REAL_ACCOUNT === 'auto';
  const catalogPath = process.env.PUI_NATIVE_ACCOUNT_CATALOG;
  if (routedAccount && !catalogPath) {
    throw new Error('Native routed-account acceptance requires PUI_NATIVE_ACCOUNT_CATALOG with accounts:list id/provider metadata');
  }
  const catalogBytes = routedAccount ? readFileSync(catalogPath!, 'utf8') : undefined;
  const catalog = catalogBytes ? JSON.parse(catalogBytes) as { accounts?: unknown } : undefined;
  const accountMetadata = catalog ? (() => {
    if (!Array.isArray(catalog.accounts)) throw new Error('Native account catalogue must contain accounts');
    return catalog.accounts.map((entry: unknown) => {
      const row = entry as Record<string, unknown> | null;
      if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(row.id)
        || !['claude', 'codex'].includes(String(row.provider))) throw new Error('Invalid native account metadata');
      // The isolated operator needs only the catalogue for route validation.
      // Credentials and all upstream selection remain in the real gateway.
      return { id: row.id, provider: row.provider, credentialRef: '', addedAt: 0, boundTo: [] };
    });
  })() : [];
  const { createOrgTestDb } = await import('../../test/_org-test-db');
  db = await createOrgTestDb();
  if (routedAccount) {
    await db.adminSql`
      INSERT INTO harness_shared.operator_account_pool (workspace_id, payload, updated_at)
      VALUES (${WORKSPACE}, ${JSON.stringify({ accounts: accountMetadata })}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
    console.info('PUI_ACCOUNT_CATALOG_DIAGNOSTIC', JSON.stringify({
      source: catalogPath, sha256: createHash('sha256').update(catalogBytes!).digest('hex'),
      accounts: accountMetadata.map(({ id, provider }) => ({ id, provider })),
    }));
  }
  const keys = [
    'HARNESS_DATABASE_URL',
    'HARNESS_ADMIN_DATABASE_URL',
    'DATABASE_URL',
    'PAPERCUSP_SKIP_PG_DISCOVERY',
    'PAPERCUSP_PGBOUNCER',
    'PAPERCUSP_LISTEN_HUB',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACES_ROOT',
    'PAPERCUSP_SERVE_UI',
    'PAPERCUSP_HONO_PORT',
    'PAPERCUSP_OPERATOR_URL',
    'PAPERCUSP_MCP_PROXY_BASE',
    'PAPERCUSP_LAUNCH_CONTEXT_DIR',
    'PAPERCUSP_SU_CODEX_HOMES_DIR',
    'PAPERCUSP_SU_OMP_HOMES_DIR',
    'PAPERCUSP_SESSION_CLAUDE_DIR',
    'PAPERCUSP_SESSION_MCP_DIR',
    'PAPERCUSP_EMBED_DEVICE',
  ];
  previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HARNESS_DATABASE_URL: db.appDsn,
    HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
    DATABASE_URL: db.adminDsn,
    PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    PAPERCUSP_PGBOUNCER: '0',
    PAPERCUSP_LISTEN_HUB: '0',
    PAPERCUSP_WORKSPACE_ID: WORKSPACE,
    PAPERCUSP_WORKSPACES_ROOT: path.join(home, '.papercusp-workspaces'),
    PAPERCUSP_SERVE_UI: '0',
    PAPERCUSP_LAUNCH_CONTEXT_DIR: path.join(home, 'launch-context'),
    PAPERCUSP_SU_CODEX_HOMES_DIR: path.join(home, 'native-codex'),
    PAPERCUSP_SU_OMP_HOMES_DIR: path.join(home, 'native-omp'),
    PAPERCUSP_SESSION_CLAUDE_DIR: path.join(home, 'native-claude'),
    PAPERCUSP_SESSION_MCP_DIR: path.join(home, 'native-mcp'),
    // This suite tests the installed PUI and operator journey, not GPU
    // availability. Keep incidental CUDA allocation failures from turning a
    // correctly recovered embedding fallback into a console-warning failure.
    PAPERCUSP_EMBED_DEVICE: 'cpu',
  });
  // The org fixture reuses numeric ids. Resolve the actual writers' roots
  // before any bootstrap so they cannot replace a real user's native home.
  const { codexHomeForSessionKey, sessionClaudeConfigDir } = await import('@papercusp/orchestrator/session-launch-dirs');
  const { ompAgentHomeForSessionKey } = await import('../session-transcript-resolvers');
  const { launchContextDir } = await import('../su-launch-context');
  for (const nativeHome of [codexHomeForSessionKey('isolation-check'),
    sessionClaudeConfigDir('isolation-check'), ompAgentHomeForSessionKey('isolation-check'), launchContextDir()]) {
    expect(path.relative(home, nativeHome).startsWith('..'), `native home escaped fixture: ${nativeHome}`).toBe(false);
  }

  const dbOrg = await import('@papercusp/db-org');
  await dbOrg._resetForTests();
  const connection = await import('../../../../libs/papercusp/libs/db/src/connection');
  connection._resetUrlCacheForTests();
  await dbOrg._resetForTests();

  const { saveHarnessRegistry } = await import('../harness-registry');
  await saveHarnessRegistry(
    {
      projects: [{ slug: HARNESS, path: REPO_ROOT, harness_kind: 'hive', self_repo: true }],
    },
    WORKSPACE,
  );
  // createOrgTestDb supplies the canonical migrated org substrate; a real
  // harness also has the production compatibility schema/views that route
  // unqualified `agent_chats` through the consolidated PG table.
  const { scaffoldHarnessSchema } = await import('../scaffold-harness-schema');
  await scaffoldHarnessSchema(HARNESS);
  if (scriptedEngine.real && process.env.PUI_REAL_APPROVAL === '1') {
    const now = Date.now();
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
         taken_by, taken_at, last_progress_at, created_ts, updated_ts)
      VALUES (${WORKSPACE}, ${HARNESS}, ${REAL_APPROVAL_WORK_ITEM}, 'task',
              'Exercise one PUI native tool-permission roundtrip',
              'Create and verify the isolated permission fixture requested by the owner.',
              'open', ${OWNER}, now(), now(), ${now}, ${now})`;
  }
  if (scriptedEngine.real && process.env.PUI_REAL_PLAN === '1') {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, version)
      VALUES (${WORKSPACE}, ${HARNESS}, ${REAL_PLAN}, 'PUI native acceptance plan', 'active',
              '# PUI native acceptance plan', 'pui-native-acceptance-plan-fixture', 1)`;
  }
  if (scriptedEngine.real && process.env.PUI_REAL_MODEL) {
    const { readAgentConfig, writeAgentConfig } = await import('../agent-config');
    const current = await readAgentConfig();
    const backend = scriptedEngine.backend === 'claude' ? 'claude-code' : scriptedEngine.backend;
    await writeAgentConfig({ ...current, tiers: [{ name: 'acceptance', spec: process.env.PUI_REAL_MODEL,
      backend: backend as 'claude-code' | 'codex' | 'omp', when: `installed ${scriptedEngine.backend} acceptance` }] });
    expect(await readAgentConfig()).toMatchObject({
      tiers: [{ name: 'acceptance', spec: process.env.PUI_REAL_MODEL, backend }],
    });
  }
  await putViewState('Plans');

  if (scriptedEngine.real) {
    const adv = await import('../adv-sessions');
    const reactivate = adv.reactivateAdvSessionByOwner;
    vi.spyOn(adv, 'reactivateAdvSessionByOwner').mockImplementation(async (ownerId) => {
      const [before] = await db.adminSql`
        SELECT id, resume_claim_key IS NOT NULL AS reserved
          FROM harness_shared.adv_sessions WHERE coord_owner_id = ${ownerId}
         ORDER BY started_at DESC LIMIT 1`;
      const changed = await reactivate(ownerId);
      if (before?.reserved) {
        const [after] = await db.adminSql`
          SELECT resume_claim_key IS NOT NULL AS reserved, ended_at IS NOT NULL AS ended
            FROM harness_shared.adv_sessions WHERE id = ${before.id}`;
        console.info('PUI_RESUME_ACTIVITY_DIAGNOSTIC', JSON.stringify({
          advSessionId: before.id, ownerId, changed, before, after,
        }));
      }
      return changed;
    });
    if (scriptedEngine.backend === 'omp') {
      const stdio = await import('../su-session-stdio-peer');
      const startPeer = stdio.startSuStdioPeer;
      vi.spyOn(stdio, 'startSuStdioPeer').mockImplementation(async (options) => {
        const mcpConfigPath = path.join(options.env.PI_CODING_AGENT_DIR!, 'mcp.json');
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
          mcpServers?: Record<string, { url?: string }>;
        };
        const configuredServers = Object.entries(mcpConfig.mcpServers ?? {}).map(([name, server]) => {
          const url = server.url ? new URL(server.url) : null;
          return { name, origin: url?.origin, pathname: url?.pathname,
            queryKeys: url ? [...url.searchParams.keys()] : [],
            ownerMatches: url?.searchParams.get('client') === options.ownerId };
        });
        if (process.env.PUI_TRACE_PROVIDER === '1') {
          // A transparent fixture-only hop records request/response boundaries;
          // the native engine still sends its real payload to the same provider.
          const modelPath = path.join(options.env.PI_CODING_AGENT_DIR!, 'models.yml');
          const models = parseYaml(readFileSync(modelPath, 'utf8'));
          const provider = models.providers['papercusp-gateway'];
          const traceOrigin = `${process.env.PAPERCUSP_OPERATOR_URL}/api/pui-provider-debug`;
          nativeProviderOrigin = nativeProviderTraceOrigin(provider.baseUrl, traceOrigin, nativeProviderOrigin);
          provider.baseUrl = traceOrigin;
          writeFileSync(modelPath, stringifyYaml(models), { mode: 0o600 });
        }
        const readNativeLogs = () => {
          const logDir = path.resolve(options.env.PI_CODING_AGENT_DIR!, '..', 'logs');
          if (!existsSync(logDir)) return [];
          return readdirSync(logDir).filter((name) => name.endsWith('.log')).flatMap((name) =>
            readFileSync(path.join(logDir, name), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
              try {
                const entry = JSON.parse(line) as Record<string, unknown>;
                if (!/mcp|provider|stream|request|timeout|error|warn/i.test(String(entry.message) + entry.level)) return [];
                const selected = Object.fromEntries(['timestamp', 'level', 'pid', 'message', 'error',
                  'name', 'path', 'provider', 'model', 'status', 'durationMs'].map((key) => [key, entry[key]]));
                return [{ file: name, entry: redactSensitiveText(JSON.stringify(selected)).slice(0, 1_000) }];
              } catch { return []; }
            }).slice(-30));
        };
        const peer = await startPeer({ ...options, onMessage(frame) {
          if (nativeFrameDiagnostics.length < 50) {
            nativeFrameDiagnostics.push({ type: frame.type, command: frame.command,
              method: frame.method, keys: Object.keys(frame), at: new Date().toISOString(),
              messageRole: (frame.message as { role?: string })?.role,
              assistantEvent: (frame.assistantMessageEvent as { type?: string })?.type });
          }
          options.onMessage(frame);
        } });
        readOmpDiagnosticState = async () => {
          const state: Record<string, unknown> = await peer.request({ type: 'get_state' }, 5_000)
            .catch((error: Error) => ({ stateReadError: error.message }));
          return { ...Object.fromEntries(['sessionId', 'sessionFile', 'isStreaming', 'isCompacting',
            'messageCount', 'queuedMessageCount', 'contextUsage', 'stateReadError'].map((key) => [key, state[key]])),
          nativeLogs: readNativeLogs(), nativeProviderEvents };
        };
        return { ...peer, async request(...args: Parameters<typeof peer.request>) {
          const command = args[0].type;
          const recordControl = (phase: string) => {
            if (command === 'prompt' || command === 'abort') {
              nativeFrameDiagnostics.push({ type: 'rpc_control', command, phase, at: new Date().toISOString() });
            }
          };
          recordControl('sent');
          const result = await peer.request(...args).then((result) => {
            recordControl('acknowledged'); return result;
          }, (error) => { recordControl('failed'); throw error; });
          if (args[0].type === 'get_state') {
            const prompt = Array.isArray(result.systemPrompt) ? result.systemPrompt : [result.systemPrompt];
            console.info('PUI_OMP_STATE_DIAGNOSTIC', JSON.stringify({
              pid: peer.pid(), agentHome: options.env.PI_CODING_AGENT_DIR,
              configDir: options.env.PI_CONFIG_DIR, keys: Object.keys(result),
              configuredServers, isStreaming: result.isStreaming, messageCount: result.messageCount,
              nativeLogs: readNativeLogs(),
              model: { id: (result.model as { id?: string })?.id,
                provider: (result.model as { provider?: string })?.provider,
                isOAuth: (result.model as { isOAuth?: boolean })?.isOAuth }, promptType: typeof result.systemPrompt,
              promptParts: prompt.map((part) => {
                const text: string = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
                return { type: typeof part, keys: typeof part === 'object' && part ? Object.keys(part) : [],
                  headings: text.match(/^#{1,3} .+$/gm)?.filter((heading) => heading.includes('MCP')),
                  connectedServers: text.split(/^## MCP Server Instructions\r?$/m).slice(1)
                    .flatMap((section) => section.split(/^#{1,2} /m, 1)[0].match(/^### [^\r\n]+/gm) ?? []),
                  routes: text.match(/xd:\/\/[^`\s]+/g)?.filter((route) => /papercusp[-_]su/i.test(route)).slice(0, 8) };
              }),
            }));
          }
          return result;
        } };
      });
    }
  }

  await startTimingProfile();
  const { app } = await import('../../../../apps/operator/bin/host-app');
  operatorServer = createAdaptorServer({
    fetch: async (request, env) => {
      const requestUrl = new URL(request.url);
      const pathname = requestUrl.pathname;
      if (process.env.PUI_TRACE_PROVIDER === '1' && pathname.startsWith('/api/pui-provider-debug/') && nativeProviderOrigin) {
        const suffix = pathname.slice('/api/pui-provider-debug'.length) + requestUrl.search;
        const headers = new Headers(request.headers);
        headers.delete('host');
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        const payload = body ? JSON.parse(new TextDecoder().decode(body)) : {};
        const systemBlocks = Array.isArray(payload.system) ? payload.system : [];
        nativeProviderEvents.push({ phase: 'request', path: pathname, at: new Date().toISOString(),
          priority: headers.get('x-papercusp-priority'), owner: headers.get('x-papercusp-owner'),
          account: headers.get('x-papercusp-account'), model: payload.model,
          systemBlockCount: systemBlocks.length,
          systemPrefixKinds: systemBlocks.slice(0, 3).map((block: { text?: string }) =>
            block.text?.startsWith('x-anthropic-billing-header:') ? 'billing'
              : block.text?.includes("You are Claude Code, Anthropic's official CLI for Claude.") ? 'claude-code' : 'other'),
        });
        try {
          const response = await fetch(`${nativeProviderOrigin}${suffix}`, {
            method: request.method, headers, body, signal: nativeProviderRequestSignal(request.signal),
          });
          nativeProviderEvents.push({ phase: 'headers', status: response.status,
            contentType: response.headers.get('content-type'), retryAfter: response.headers.get('retry-after'),
            at: new Date().toISOString(),
            errorBody: response.ok ? undefined : redactSensitiveText(await response.clone().text()).slice(0, 1_500) });
          return response;
        } catch (error) {
          nativeProviderEvents.push({ phase: 'error', message: redactSensitiveText(String(error)), at: new Date().toISOString() });
          throw error;
        }
      }
      if (pathname === '/api/mcp' && request.method === 'POST' && process.env.PUI_DELAY_MCP_INITIALIZE_MS) {
        const rpc = await request.clone().json().catch(() => ({})) as { method?: string };
        if (rpc.method === 'initialize') await new Promise((resolve) => setTimeout(resolve,
          Math.min(5_000, Math.max(0, Number(process.env.PUI_DELAY_MCP_INITIALIZE_MS) || 0))));
      }
      const requestStarted = performance.now();
      const traceFields = { path: pathname, query: requestUrl.searchParams.get('name') };
      traceTiming('request-start', traceFields);
      if (pathname === '/api/zero-harness/rest-query' && traceFields.query) {
        namedQueryRequests.push(traceFields.query);
      }
      if (request.method === 'POST' && pathname === '/api/agent-mcp/run-tool') {
        const input = await request.clone().json() as { name?: string; args?: { cell?: string } };
        if (input.name === 'state:read' && input.args?.cell && PIPELINE_CELLS.has(input.args.cell)) {
          pipelineCellRequests.push(input.args.cell);
        }
      }
      const isLaunch = pathname === '/api/adv/sessions/launch-su';
      const launchInput = isLaunch ? await request.clone().json() : null;
      if (isLaunch) launchRequests.push(launchInput);
      const isCommand = request.method === 'POST' && pathname.endsWith('/su-session/commands');
      if (isCommand) commandPosts.push(await request.clone().json() as SuSessionCommand);
      if (isLaunch && transportFault === 'startup-disconnect') {
        transportFault = 'none';
        return Response.json({ error: 'PUI-E2E startup connection interrupted' }, { status: 503 });
      }
      const host = scriptedEngine.engines.at(-1)?.adapter.host;
      if (isCommand && transportFault === 'refuse') host?.transition('starting', 'injected readiness withdrawal');
      let response: Response;
      try {
        response = await app.fetch(request, env);
      } catch (error) {
        console.info('PUI_REQUEST_FAILURE', JSON.stringify({ path: pathname,
          message: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
      if (pathname === '/api/tui/identity' && attachedCapability !== 'current') {
        const identity = await response.json();
        if (attachedCapability === 'missing') delete identity.capabilities;
        else if (attachedCapability === 'unsafe') delete identity.capabilities.attachedSuSessionApprovals;
        else identity.capabilities = { ...identity.capabilities, attachedSuSession: false };
        response = Response.json(identity, { status: response.status });
      }
      if (pathname.endsWith('/card-response')) cardReplies.push({ path: pathname, status: response.status });
      traceTiming('request-end', { ...traceFields, elapsedMs: performance.now() - requestStarted, status: response.status });
      if (pathname === '/api/zero-harness/rest-query' && traceFields.query) {
        namedQueryReplies.push({ name: traceFields.query, status: response.status });
      }
      if (isCommand) {
        const body = await response.clone().json();
        commandReplies.push({ status: response.status, replayed: body.replayed });
        if (transportFault === 'refuse') {
          host?.transition('ready', 'readiness restored');
          transportFault = 'none';
        } else if (transportFault === 'lost-ack') {
          response = new Response('PUI-E2E acknowledgement connection lost', { status: 502 });
        } else if (transportFault === 'wrong-command-ack') {
          response = Response.json({ ...body, accepted: { ...body.accepted, commandId: 'unrelated-command' } }, { status: response.status });
        } else if (transportFault === 'wrong-session-ack') {
          response = Response.json({ ...body, accepted: { ...body.accepted, session: { ...body.accepted.session, nativeSessionId: 'unrelated-native-session' } } }, { status: response.status });
        }
      }
      if (pathname.endsWith('/su-session/events') && transportFault.endsWith('-ack')) {
        response = withoutCommandReceipts(response);
      }
      if (isLaunch || pathname.includes('/su-session')) {
        const streamedLaunch = isLaunch && response.headers.get('content-type')?.includes('text/event-stream') === true;
        const result = isLaunch && !streamedLaunch ? await response.clone().json() : null;
        // Keep an allowlisted trace of the production boundary. Never capture
        // authorization headers, endpoint credentials or arbitrary request text.
        const observation: Record<string, unknown> = {
          method: request.method,
          path: pathname,
          status: response.status,
          count: 1,
          ...(isLaunch ? {
            streamed: streamedLaunch,
            agent: launchInput?.agent,
            model: launchInput?.model,
            account: launchInput?.account,
            mode: launchInput?.mode,
            carry: launchInput?.carry,
            planSlug: launchInput?.plan_slug,
            deferSpawn: launchInput?.defer_spawn,
            attachedEngine: launchInput?.attached_engine === true,
            transport: result?.transport,
            headless: launchInput?.headless === true,
            deferred: result?.deferred === true,
            advSessionId: result?.advSessionId,
            nativeSessionPresent: Boolean(result?.nativeSession),
            ...(result?.error ? { errorCode: result.code,
              error: (typeof result.error === 'string' ? result.error : JSON.stringify(result.error)).slice(0, 500) } : {}),
          } : {}),
        };
        const existing = sessionTraffic.find((entry) =>
          entry.method === observation.method && entry.path === pathname && entry.status === response.status);
        if (existing) existing.count = Number(existing.count) + 1;
        else if (sessionTraffic.length < 30) sessionTraffic.push(observation);
        if (streamedLaunch) {
          // Observe the final typed launch result from a CLONE without holding
          // the response away from the PUI. Awaiting response.json() here turns
          // text/event-stream into a parse exception and an artificial HTTP 500.
          const observed = response.clone();
          void (async () => {
            for await (const event of parseSseStream(observed.body)) {
              if (event.event !== 'launch-result') continue;
              const terminal = JSON.parse(event.data) as { httpStatus?: number; body?: Record<string, unknown> };
              const body = terminal.body ?? {};
              Object.assign(observation, {
                status: terminal.httpStatus ?? observation.status,
                transport: body.transport,
                deferred: body.deferred === true,
                advSessionId: body.advSessionId,
                nativeSessionPresent: Boolean(body.nativeSession),
                ...(body.error ? { errorCode: body.code,
                  error: (typeof body.error === 'string' ? body.error : JSON.stringify(body.error)).slice(0, 500) } : {}),
              });
            }
          })().catch((error: unknown) => console.info('PUI_LAUNCH_STREAM_OBSERVATION_FAILURE',
            error instanceof Error ? error.message : String(error)));
        }
      }
      return response;
    },
  });
  operatorPort = await listen(operatorServer);
  // Native lifecycle hooks and MCP must rendezvous with this isolated host,
  // never the developer's inherited live/staging endpoint or shared proxy.
  process.env.PAPERCUSP_HONO_PORT = String(operatorPort);
  process.env.PAPERCUSP_OPERATOR_URL = `http://127.0.0.1:${operatorPort}`;
  process.env.PAPERCUSP_MCP_PROXY_BASE = `http://127.0.0.1:${operatorPort}`;
  // Fail at the actual rendezvous boundary instead of spending every PTY
  // timeout on a fixture operator that the installed client cannot identify.
  const identityResponse = await fetch(`http://127.0.0.1:${operatorPort}/api/tui/identity`);
  const identity = await identityResponse.json();
  expect(identityResponse.status, JSON.stringify(identity)).toBe(200);
  expect(identity).toMatchObject({
    schemaVersion: 1,
    workspaceId: WORKSPACE,
    agentChat: { scope: `workspace:${WORKSPACE}` },
  });
  // Release acceptance (P-012 / D-018): every PUI_*_ACCEPTANCE line in this
  // file was produced against the production operator app, not a fixture.
  console.info(HARNESS_TAG, JSON.stringify({ operator: 'production', app: 'apps/operator/bin/host-app',
    binary: bin, binarySha256 }));
}, 900_000);

afterAll(async () => {
  await finishTeardown([
    stopEngines,
    () => close(operatorServer),
    async () => { const { drainDetached } = await import('../detached-imports'); await drainDetached(); },
    async () => { await finishTeardown(maintenance.jobs.splice(0).map((job) => () => job.stop())); },
    async () => { const { stopInvalidationListener } = await import('../sync-sse'); await stopInvalidationListener(); },
    async () => { const dbOrg = await import('@papercusp/db-org'); await dbOrg._resetForTests(); },
    async () => { await db?.cleanup(); },
    () => {
      for (const [key, value] of Object.entries(previousEnv ?? {})) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (home) rmSync(home, { recursive: true, force: true });
    },
  ]);
}, 120_000);

afterEach(stopEngines);

beforeEach(async () => {
  namedQueryRequests.length = 0;
  namedQueryReplies.length = 0;
  pipelineCellRequests.length = 0;
  sessionTraffic = [];
  launchRequests = [];
  attachedCapability = 'current';
  nativeTerminalLaunch.mockClear();
  commandPosts = [];
  commandReplies = [];
  cardReplies = [];
  transportFault = 'none';
  scriptedEngine.mode = 'success';
  scriptedEngine.successText = 'PUI structured engine replied';
  scriptedEngine.questionCallId = 'pui-question-tool';
  scriptedEngine.questionVerdicts = [];
  scriptedEngine.approvalRequests = [
    { tag: 'ALPHA', input: { command: 'echo PUI-APPROVAL-ALPHA' } },
    { tag: 'BETA', input: { command: 'echo PUI-APPROVAL-BETA' } },
  ];
  scriptedEngine.approvalVerdicts = [];
  scriptedEngine.approvalExecuted = [];
  scriptedEngine.streamChunks = ['STREAM-A1 ', 'STREAM-B2 ', 'STREAM-C3 ', 'STREAM-D4 ', 'STREAM-E5'];
  scriptedEngine.streamDelayMs = 800;
  scriptedEngine.editPath = 'apps/tui/src/pui_diff_probe.rs';
  scriptedEngine.editOld = 'fn probe() {\n    let kept = 1;\n    let dropped = 2;\n}';
  scriptedEngine.editNew = 'fn probe() {\n    let kept = 1;\n    let introduced = 3;\n}';
  scriptedEngine.questionPrompt = 'Keep or change the draft title?';
  scriptedEngine.questionOptions = ['Keep', 'Change'];
  scriptedEngine.requests = [];
  scriptedEngine.sdkPermissions = [];
  scriptedEngine.sdkSessions = [];
  scriptedEngine.events = [];
  scriptedEngine.initialization = Promise.resolve();
  initializeWarnings = [];
  optionalMemoryWarnings = [];
  configurationWarnings = [];
  intentPivotWarnings = [];
  timeoutDegradations = [];
  nativeFrameDiagnostics = [];
  if (scriptedEngine.real) {
    const error = console.error.bind(console);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (scriptedEngine.backend === 'omp' && args.length === 1 && typeof args[0] === 'string'
        && /^psu: CONFIG ERROR — modelRoles\.default \(openrouter\/stealth\/ox-alpha\) is a RETIRED upstream model that 404s; rewriting this session's copy to [^\s]+\. Fix your global ~\/\.omp\/agent\/config\.yml\.$/.test(args[0])) {
        // EI-21919040934117285: the real machine has this obsolete default.
        // Exercise its existing session-only repair and preserve the warning
        // in acceptance evidence. Never rewrite the user's global config.
        configurationWarnings.push(args[0]);
        console.info('PUI_CONFIG_REPAIR_DIAGNOSTIC', args[0]);
      } else error(...args);
    });
    const warn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[mcp-initialize-stage]') {
        // Optional memory enrichment has a bounded production fallback in a
        // fresh test DB. Retain that diagnostic and prove the actual MCP
        // connection works; any other warning remains a test failure.
        const detail = args[1] as Record<string, unknown>;
        expect(['base', 'enriched', 'timeout']).toContain(detail.outcome);
        initializeWarnings.push(detail);
        console.info('PUI_MCP_INITIALIZE_DIAGNOSTIC', JSON.stringify(detail));
      } else if (args.length === 1 && args[0] === '[memory-injection] block build exceeded the 2000ms prompt-build deadline — omitting the section this turn; the in-flight build will serve the next one (P-010).') {
        // A fresh isolated DB can take the documented optional-enrichment
        // fallback. Preserve the exact diagnostic; hard memory/SU errors and
        // every other warning still fail this test (EI-22628413686876169).
        optionalMemoryWarnings.push(String(args[0]));
        console.info('PUI_OPTIONAL_MEMORY_DIAGNOSTIC', args[0]);
      } else if (args.length === 1 && args[0] === '[bounded-timeout] intent-pivot-embed exceeded 1500ms — degrading to fallback') {
        // detectIntentPivot deliberately returns the lexical method within
        // this budget. Its unit suite exercises that fallback. Retain this
        // exact advisory diagnostic in native acceptance; unexpected warnings
        // still fail, and this says nothing about embedding service health.
        intentPivotWarnings.push(String(args[0]));
        console.info('PUI_INTENT_PIVOT_DIAGNOSTIC', args[0]);
      } else if (args.length === 1 && typeof args[0] === 'string'
        && /^\[bounded-timeout\] \S.* exceeded \d+ms — degrading to fallback$/.test(args[0])) {
        // D-024: a read that outran its budget and returned its declared
        // fallback is the product's designed behaviour on a slow host, and the
        // exact reads differ run to run with box load (turn-start surface,
        // obligations, frontier). Keep each as evidence and let the journey's
        // own assertions judge correctness. The ERROR form ("… failed: …") and
        // every other warning still fail the test.
        traceTiming('diagnostic-warning', { label: args[0] });
        timeoutDegradations.push(args[0]);
        console.info('PUI_TIMEOUT_DEGRADATION_DIAGNOSTIC', args[0]);
      } else {
        warn(...args);
      }
    });
  }
  await db.adminSql`
    TRUNCATE harness_shared.agent_chat_locks,
      harness_shared.agent_loop_approvals,
      harness_shared.agent_loop_sessions,
      harness_shared.agent_chats_consolidated CASCADE
  `;
  await putViewState('Plans');
});

/**
 * P-008 session/context/command clauses. Each case uses the installed/current
 * pui binary, a real PTY, the production Hono operator, and migrated Postgres.
 */
describe.skipIf(scriptedEngine.real).sequential('PUI P-008 sessions and context (spec clauses)', () => {
  // PUI-USAGE — "Unavailable context or cost information is displayed as
  // unknown." Falsifier: "PUI substitutes a fabricated token count or cost for
  // missing backend measurements."
  test('PUI-USAGE: absent provider measurements render unknown instead of fabricated zero', async () => {
    const chatId = `pui-usage-${randomUUID()}`;
    await seedAgentChat({
      id: chatId,
      title: 'PUI usage unknown fixture',
      runtimeClass: 'su-session',
      transcript: [
        { role: 'user', content: 'Usage probe', ts: '2026-09-13T10:00:00Z' },
        {
          role: 'assistant',
          content: 'Provider replied without a usage frame',
          ts: '2026-09-13T10:00:01Z',
          unreportedFrames: 1,
        },
      ],
      // Positive calibration: the aggregate schema's real zero values are
      // present. `usage_complete=false`, derived by the production SQL mapper,
      // is what prevents the UI from misreporting these as measured.
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
    await putViewState('Operator');

    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('Provider replied without a usage frame', { timeoutMs: 60_000 });
      await pane.waitFor('usage in unknown / out unknown / cost unknown / context unknown');
      const frame = pane.screen();
      expect(frame).not.toContain('cost $0.0000');
      expect(frame).not.toContain('usage in 0 / out 0');
      const [stored] = await db.adminSql<Array<{
        total_input_tokens: number;
        total_output_tokens: number;
        total_cost_usd_cents: number;
      }>>`
        SELECT total_input_tokens, total_output_tokens, total_cost_usd_cents
          FROM harness_shared.agent_chats_consolidated
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${chatId}`;
      expect(stored).toMatchObject({
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd_cents: 0,
      });
      console.info('PUI_USAGE_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, chatId, stored, frame,
      }));
    } catch (error) {
      console.info('PUI_USAGE_FAILURE', JSON.stringify({ chatId, ...pane.failureEvidence() }));
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('AUTO-BAR-R-04-P-008: legacy continuation preserves source identity, history and the unsent draft', async ({ onTestFailed }) => {
    const sourceId = `pui-legacy-${randomUUID()}`;
    const siblingId = `pui-legacy-sibling-${randomUUID()}`;
    const now = Date.now();
    const history = [
      { role: 'user', content: 'P8 legacy question', ts: new Date(now - 3_000).toISOString() },
      { role: 'assistant', content: 'P8 legacy answer', ts: new Date(now - 2_000).toISOString() },
    ];
    const draft = '  P8 preserved continuation draft λ  ';
    let stage = 'seed';
    let pane: PuiPane | undefined;
    onTestFailed(() => console.info('PUI_LEGACY_CONTINUATION_FAILURE', JSON.stringify({
      sourceId, siblingId, stage, ...(pane?.failureEvidence() ?? {}),
    })));
    await seedAgentChat({
      id: sourceId, title: 'P8 legacy source', runtimeClass: 'legacy-owned-loop',
      transcript: history, createdAt: now - 2_000, updatedAt: now - 2_000,
    });
    await seedAgentChat({
      id: siblingId, title: 'P8 other history', runtimeClass: 'legacy-owned-loop',
      transcript: [
        { role: 'user', content: 'P8 unrelated question', ts: new Date(now).toISOString() },
        { role: 'assistant', content: 'P8 unrelated answer', ts: new Date(now).toISOString() },
      ],
      createdAt: now, updatedAt: now,
    });
    await ingestSeededAgentChats();
    const readSource = async () => {
      const [row] = await db.adminSql<Array<{ snapshot: Record<string, unknown> }>>`
        SELECT to_jsonb(c) AS snapshot FROM harness_shared.agent_chats_consolidated c
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${sourceId}`;
      return row.snapshot;
    };
    const sourceBefore = await readSource();
    await putViewState('Sessions');
    pane = new PuiPane(bin, operatorPort, home);
    try {
      stage = 'compose-before-continuation';
      await pane.waitFor('P8 legacy source', { timeoutMs: 40_000 });
      await openComposer(pane, false);
      pane.write(draft);
      await pane.waitFor(draft.trim());
      pane.escape();
      pane.write('s');
      await pane.waitFor('e rename · d archive · K continue/fork');

      stage = 'open-legacy-history';
      pane.write('/P8 legacy source');
      pane.enter();
      await pane.waitForGone('P8 other history');

      stage = 'continue';
      pane.write('K');
      await pane.waitFor('SU session · ready', { timeoutMs: 60_000 });
      await pane.waitFor('P8 legacy answer');
      const [successor] = await db.adminSql<Array<{
        id: string; su_runtime_class: string; continued_from_chat_id: string;
        continued_from_turn_count: number; transcript: typeof history;
      }>>`
        SELECT id, su_runtime_class, continued_from_chat_id, continued_from_turn_count, transcript
          FROM harness_shared.agent_chats_consolidated
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
           AND continued_from_chat_id = ${sourceId}`;
      expect(successor).toMatchObject({
        su_runtime_class: 'su-session', continued_from_chat_id: sourceId,
        continued_from_turn_count: history.length, transcript: history,
      });
      expect(successor.id).not.toBe(sourceId);
      expect(await readSource()).toEqual(sourceBefore);
      expect(scriptedEngine.requests).toEqual([]);
      expect(commandPosts.filter((command) => command.type === 'owner_turn')).toEqual([]);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();

      stage = 'preserve-text-on-successor';
      // No retyping: the draft entered before navigating to Sessions must
      // survive the linked continuation and reach only its new successor.
      pane.write('i');
      await pane.waitFor('Message — Enter send', { timeoutMs: 60_000 });
      await pane.waitFor(draft.trim());
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      const saved = await waitForSavedTurn(draft);
      expect(saved.id).toBe(successor.id);
      expect(saved.transcript.slice(0, history.length)).toEqual(history);
      expect(scriptedEngine.requests).toEqual([draft]);
      expect(await readSource()).toEqual(sourceBefore);
      expect((await persistedChats(db)).find((chat) => chat.id === siblingId)?.transcript)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ content: draft })]));
      console.info('PUI_LEGACY_CONTINUATION_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, sourceId, successorId: successor.id,
        sourceBefore, sourceAfter: await readSource(), frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 180_000);

  // AUTO-BAR-R-03-P-008 — "The context pane displays the selected session's
  // project and durable work context." Falsifier: "Switching sessions leaves
  // another session's context or global test data in the pane."
  test('AUTO-BAR-R-03-P-008: Context follows the selected session in the wide rail and the compact Ctrl-T surface', async ({ onTestFailed }) => {
    const suffix = randomUUID().slice(0, 8);
    const alpha = {
      id: `pui-r03-alpha-${randomUUID()}`,
      title: `P8 R03 alpha ${suffix}`,
      task: `R03 alpha-only task ${suffix}`,
    };
    const beta = {
      id: `pui-r03-beta-${randomUUID()}`,
      title: `P8 R03 beta ${suffix}`,
      task: `R03 beta-only task ${suffix}`,
      workItem: `WI-P8R03-${suffix}`,
    };
    let stage = 'seed';
    let pane: PuiPane | undefined;
    onTestFailed(() => console.info('PUI_R03_CONTEXT_FAILURE', JSON.stringify({
      stage, alpha, beta, ...(pane?.failureEvidence() ?? {}),
    })));
    // Alpha is the newest writable operator chat, so PUI binds it on launch;
    // beta's linked work item keeps it out of that default. Both are later than
    // every earlier case's chat in this sequential block.
    const now = Date.now();
    const turns = (label: string) => [
      { role: 'user', content: `R03 ${label} question`, ts: new Date(now).toISOString() },
      { role: 'assistant', content: `R03 ${label} answer`, ts: new Date(now).toISOString() },
    ];
    await seedAgentChat({
      id: beta.id, title: beta.title, runtimeClass: 'su-session', featureId: beta.workItem,
      transcript: turns('beta'), createdAt: now + 60_000, updatedAt: now + 60_000,
    });
    await seedAgentChat({
      id: alpha.id, title: alpha.title, runtimeClass: 'su-session',
      transcript: turns('alpha'), createdAt: now + 120_000, updatedAt: now + 120_000,
    });
    // Durable work context: one canonical task per session, keyed only by its
    // own session id — the same rows the Context projection reads.
    for (const [sessionId, content] of [[alpha.id, alpha.task], [beta.id, beta.task]]) {
      await db.adminSql`
        INSERT INTO harness_shared.session_tasks
          (workspace_id, session_id, task_id, position, content, active_form, status, created_at, updated_at)
        VALUES (${WORKSPACE}, ${sessionId}, 'r03-task', 0, ${content}, ${content}, 'in_progress', now(), now())`;
    }
    await putViewState('Operator');

    pane = new PuiPane(bin, operatorPort, home, { cols: 170, rows: 44 });
    try {
      stage = 'wide-alpha';
      await openAgentChat(pane);
      await pane.waitFor('R03 alpha answer', { timeoutMs: 40_000 });
      await pane.waitFor('Context · Ctrl-T');
      await pane.waitFor(alpha.task, { timeoutMs: 30_000 });
      expect(pane.screen()).toMatch(new RegExp(`Harness\\s+${HARNESS}`));
      expect(pane.screen()).not.toContain(beta.task);
      expect(pane.screen()).not.toContain(beta.workItem);

      stage = 'switch-to-beta';
      pane.escape();
      await pane.waitFor('i type · v speak');
      pane.write('l');
      await pane.waitFor(beta.title);
      // Rows read `[● ]<role> · <title> · N turns`; the selection carries the
      // list's `> ` marker. Step until the selected row is beta.
      await vi.waitFor(() => {
        const selected = pane!.screen().split('\n').find((line) => /> (● )?operator · /.test(line));
        if (!selected?.includes(beta.title)) {
          pane!.write('j');
          throw new Error(`picker selection is not beta yet: ${selected ?? '(no selected row)'}`);
        }
      }, { timeout: 20_000, interval: 250 });
      pane.enter();

      stage = 'wide-beta';
      await pane.waitFor('R03 beta answer', { timeoutMs: 40_000 });
      await pane.waitFor(beta.task, { timeoutMs: 30_000 });
      await pane.waitFor(beta.workItem);
      await pane.waitForGone(alpha.task, { timeoutMs: 30_000 });
      expect(pane.screen()).toMatch(new RegExp(`Harness\\s+${HARNESS}`));

      stage = 'compact-ctrl-t';
      pane.resize(100, 22);
      await pane.waitForGone('Context · Ctrl-T');
      pane.write('\x14');
      await pane.waitFor('Esc/o Agent Chat');
      await pane.waitFor(beta.task);
      expect(pane.screen()).not.toContain(alpha.task);
      pane.escape();
      await pane.waitFor('┌ Agent Chat');

      const tasks = await db.adminSql<Array<{ session_id: string; content: string }>>`
        SELECT session_id, content FROM harness_shared.session_tasks
         WHERE workspace_id = ${WORKSPACE} AND session_id IN (${alpha.id}, ${beta.id})
         ORDER BY content`;
      expect(tasks).toEqual([
        { session_id: alpha.id, content: alpha.task },
        { session_id: beta.id, content: beta.task },
      ]);
      console.info('PUI_R03_CONTEXT_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, alpha, beta, frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 240_000);

  // AUTO-BAR-R-07-P-008 — "The default PUI view prioritizes the active
  // conversation and its contextual work surface." Probe: normal and compact
  // layouts with unrelated global activity present; inspect default focus and
  // visible content. Falsifier: "Unrelated fleet or global system information
  // displaces the active conversation on launch."
  test('AUTO-BAR-R-07-P-008: a default launch opens on the active conversation and its Context despite unrelated activity, normal and compact', async ({ onTestFailed }) => {
    const suffix = randomUUID().slice(0, 8);
    const active = {
      id: `pui-r07-active-${randomUUID()}`,
      title: `P8 R07 active ${suffix}`,
      answer: `R07 active answer ${suffix}`,
      task: `R07 active task ${suffix}`,
    };
    // Newer than the active conversation and carrying its own work: the most
    // recent activity in the workspace, but not a conversation the owner has
    // open. It must not be what a default launch shows.
    const unrelated = {
      id: `pui-r07-unrelated-${randomUUID()}`,
      title: `P8 R07 unrelated ${suffix}`,
      answer: `R07 unrelated answer ${suffix}`,
      task: `R07 unrelated task ${suffix}`,
      workItem: `WI-P8R07-${suffix}`,
    };
    const draft = `P8 compact draft ${suffix}`;
    let stage = 'seed';
    let pane: PuiPane | undefined;
    onTestFailed(() => console.info('PUI_R07_DEFAULT_FAILURE', JSON.stringify({
      stage, active, unrelated, ...(pane?.failureEvidence() ?? {}),
    })));
    const now = Date.now();
    const turns = (answer: string) => [
      { role: 'user', content: 'R07 question', ts: new Date(now).toISOString() },
      { role: 'assistant', content: answer, ts: new Date(now).toISOString() },
    ];
    await seedAgentChat({
      id: active.id, title: active.title, runtimeClass: 'su-session', transcript: turns(active.answer),
      createdAt: now + 300_000, updatedAt: now + 300_000,
    });
    await seedAgentChat({
      id: unrelated.id, title: unrelated.title, runtimeClass: 'su-session', featureId: unrelated.workItem,
      transcript: turns(unrelated.answer), createdAt: now + 400_000, updatedAt: now + 400_000,
    });
    for (const [sessionId, content] of [[active.id, active.task], [unrelated.id, unrelated.task]]) {
      await db.adminSql`
        INSERT INTO harness_shared.session_tasks
          (workspace_id, session_id, task_id, position, content, active_form, status, created_at, updated_at)
        VALUES (${WORKSPACE}, ${sessionId}, 'r07-task', 0, ${content}, ${content}, 'in_progress', now(), now())`;
    }
    // A DEFAULT launch: no saved destination for this owner at all.
    await db.adminSql`DELETE FROM harness_shared.tui_view_state WHERE owner_id = ${OWNER}`;
    const assertNoUnrelated = () => {
      const frame = pane!.screen();
      for (const marker of [unrelated.title, unrelated.answer, unrelated.task, unrelated.workItem]) {
        expect(frame, `unrelated activity on screen (${stage})`).not.toContain(marker);
      }
    };

    pane = new PuiPane(bin, operatorPort, home, { cols: 170, rows: 44 });
    try {
      stage = 'normal-launch';
      await pane.waitFor('· pui ·', { timeoutMs: 40_000 });
      // First-run guidance is the one overlay a default launch may show.
      if (pane.screen().includes('Welcome to pui')) {
        pane.escape();
        await pane.waitForGone('Welcome to pui');
      }
      // No navigation key: the launch itself must land on the conversation.
      await pane.waitFor('┌ Agent Chat');
      await pane.waitFor(active.answer, { timeoutMs: 40_000 });
      await pane.waitFor('Context · Ctrl-T');
      await pane.waitFor(active.task, { timeoutMs: 30_000 });
      assertNoUnrelated();

      stage = 'compose';
      if (!pane.screen().includes('Message — Enter send')) pane.write('i');
      await pane.waitFor('Message — Enter send');
      pane.write(draft);
      await pane.waitFor(draft);

      // 100x22 is the contract's compact band (80–159 columns, 20–23 rows):
      // one primary surface — Agent Chat with the draft — and no rail.
      stage = 'compact';
      pane.resize(100, 22);
      await pane.waitForGone('Context · Ctrl-T');
      await pane.waitFor('┌ Agent Chat');
      await pane.waitFor(draft);
      await pane.waitFor('Message — Enter send');
      expect(pane.screen()).not.toContain('Terminal too small');
      assertNoUnrelated();

      stage = 'normal-again';
      pane.resize(170, 44);
      await pane.waitFor('Context · Ctrl-T');
      await pane.waitFor(active.task);
      await pane.waitFor(draft);
      assertNoUnrelated();
      console.info('PUI_R07_DEFAULT_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, active, unrelated, draft,
        normal: '170x44', compact: '100x22', frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 180_000);

  test('PUI-COMMANDS: help and the command palette discover and execute a harmless extension', async ({ onTestFailed }) => {
    await putViewState('Plans');
    let stage = 'help';
    const pane = new PuiPane(bin, operatorPort, home);
    onTestFailed(() => console.info('PUI_COMMANDS_FAILURE', JSON.stringify({ stage, ...pane.failureEvidence() })));
    try {
      await pane.waitFor('?:help', { timeoutMs: 40_000 });
      pane.write('?');
      await pane.waitFor('command palette');
      await pane.waitFor(':theme');
      pane.escape();

      // PUBLIC_RELEASE_UX.md: `:` is the one palette, and live catalog/recipe
      // search discovers commands, skills, plugins and tools — then runs one.
      // The executed action is a read-only catalog tool (`tools:find`) invoked
      // through `tools:invoke`, the same server-gated plane extensions use.
      // It runs BEFORE `:tutorial`: dismissing the tutorial with no bound
      // conversation starts the first-run setup, which would take the keys.
      stage = 'catalog';
      pane.write(':');
      await pane.waitFor('Command (Esc closes)');
      pane.write('tool find tools by intent');
      pane.enter();
      await pane.waitFor('Tools · results (Esc closes)', { timeoutMs: 40_000 });
      expect(pane.screen()).toMatch(/\d+ tool match(es)? · ↑\/↓ select · Enter arguments/);
      await vi.waitFor(() => {
        if (!/▶ tools:find\b/.test(pane.screen())) {
          pane.write('\x1b[B');
          throw new Error('tool palette selection is not tools:find yet');
        }
      }, { timeout: 20_000, interval: 250 });
      stage = 'arguments';
      pane.enter();
      await pane.waitFor('Tools · arguments · tools:find');
      // tools:find declares no REQUIRED field (q?/query?), so the palette asks
      // only for the optional-extras JSON object.
      await pane.waitFor('optional extras JSON object');
      pane.write('{"query":"command palette"}');
      pane.enter();
      stage = 'invoke';
      await pane.waitFor('Tools · result · tools:find', { timeoutMs: 40_000 });
      // The result card leads with ✓ on success and ✗ on failure; the palette
      // popup owns these rows, so read them from the popup, not the page.
      const popup = pane.screen().split('\n')
        .filter((line) => line.includes('✓') || line.includes('✗') || line.includes('error  '));
      expect(popup.some((line) => line.includes('✓'))).toBe(true);
      expect(popup.filter((line) => line.includes('✗') || line.includes('error  '))).toEqual([]);
      pane.escape();
      await pane.waitForGone('Tools · result · tools:find');

      stage = 'tutorial';
      pane.write(':');
      await pane.waitFor('Command (Esc closes)');
      pane.write('tutorial');
      pane.enter();
      await pane.waitFor('Welcome to pui — the Papercusp workbench');
      console.info('PUI_COMMANDS_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, commands: [':tutorial', ':tool find tools by intent → tools:find'],
        frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 120_000);

  test('PUI-SESSION-LIFECYCLE: session browser keeps isolated history addressable and supports rename/archive', async ({ onTestFailed }) => {
    const sourceId = `pui-session-source-${randomUUID()}`;
    const siblingId = `pui-session-sibling-${randomUUID()}`;
    const now = Date.now();
    let stage = 'seed-source';
    let pane: PuiPane | undefined;
    onTestFailed(() => {
      console.info('PUI_SESSION_LIFECYCLE_FAILURE', JSON.stringify({
        stage, sourceId, siblingId, ...(pane?.failureEvidence() ?? {}),
      }));
    });
    await seedAgentChat({
      id: sourceId,
      title: 'P8 source',
      runtimeClass: 'legacy-owned-loop',
      transcript: [
        { role: 'user', content: 'source history', ts: new Date(now - 3_000).toISOString() },
        { role: 'assistant', content: 'source answer', ts: new Date(now - 2_000).toISOString() },
      ],
      createdAt: now - 2_000,
      updatedAt: now - 2_000,
    });
    stage = 'seed-sibling';
    await seedAgentChat({
      id: siblingId,
      title: 'P8 sibling',
      runtimeClass: 'su-session',
      transcript: [
        { role: 'user', content: 'sibling history', ts: new Date(now - 1_000).toISOString() },
        { role: 'assistant', content: 'sibling answer', ts: new Date(now).toISOString() },
      ],
      createdAt: now,
      updatedAt: now,
    });
    stage = 'index-chats';
    await ingestSeededAgentChats();
    // Scoped to this test's two chats: earlier cases in this sequential block
    // (R-04's legacy source + sibling) index their own turns into the same
    // workspace, so a workspace-wide count measures test order, not this case.
    const indexed = await db.adminSql<Array<{ session_id: string; text: string }>>`
      SELECT session_id, text FROM harness_shared.session_turns
       WHERE workspace_id = ${WORKSPACE} AND source_kind = 'agent_chat'
         AND session_id IN (${sourceId}, ${siblingId})
       ORDER BY session_id, turn_idx`;
    expect(indexed).toHaveLength(4);
    expect(new Set(indexed.map((row) => row.session_id))).toEqual(new Set([sourceId, siblingId]));
    stage = 'save-view';
    await putViewState('Sessions');

    stage = 'open-sessions';
    // The server-backed search below reaches the embedding leg, whose HNSW
    // capability probe warns deterministically against this fixture's Postgres
    // (measured: run 218aa430, alone). Allowed, never required — the same
    // contract as work-items-urgent.test.ts — and any OTHER warning fails.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('sessions', { timeoutMs: 40_000 });
      await pane.waitFor('P8 source', { timeoutMs: 40_000 });
      await pane.waitFor('P8 sibling', { timeoutMs: 40_000 });

      // Search is server-backed and selection remains scoped to the exact
      // agent-chat identity, not a similarly-labelled native history row.
      stage = 'search-source';
      pane.write('/P8 source');
      pane.enter();
      await pane.waitFor('P8 source', { timeoutMs: 20_000 });
      await pane.waitForGone('P8 sibling', { timeoutMs: 20_000 });
      stage = 'rename-source';
      pane.write('e');
      await pane.waitFor('RENAME');
      pane.write('P8 renamed');
      pane.enter();
      // Notifications are muted in the default workbench. Verify the write
      // itself, then find the new title: the old title filter no longer matches.
      await vi.waitFor(async () => {
        const [renamed] = await db.adminSql<Array<{ title: string }>>`
          SELECT title FROM harness_shared.agent_chats_consolidated
           WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${sourceId}`;
        expect(renamed?.title).toBe('P8 renamed');
      }, { timeout: 30_000, interval: 100 });
      pane.escape();
      await pane.waitFor('P8 renamed', { timeoutMs: 30_000 });
      pane.write('/P8 renamed');
      pane.enter();
      await pane.waitForGone('P8 sibling', { timeoutMs: 20_000 });

      stage = 'archive-source';
      pane.write('d');
      await pane.waitFor('ARCHIVE P8 renamed?');
      pane.write('y');
      await vi.waitFor(async () => {
        const [archived] = await db.adminSql<Array<{ archived_at: string | null }>>`
          SELECT archived_at FROM harness_shared.agent_chats_consolidated
           WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${sourceId}`;
        expect(archived?.archived_at).toBeTruthy();
      }, { timeout: 30_000, interval: 100 });
      await pane.waitForGone('ARCHIVE P8 renamed?');
      await pane.waitFor('P8 renamed');

      const [stored] = await db.adminSql<Array<{ id: string; title: string; archived_at: string | null }>>`
        SELECT id, title, archived_at
          FROM harness_shared.agent_chats_consolidated
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${sourceId}`;
      expect(stored).toMatchObject({ id: sourceId, title: 'P8 renamed' });
      expect(stored.archived_at).toBeTruthy();
      const [sibling] = await db.adminSql<Array<{ title: string; archived_at: string | null }>>`
        SELECT title, archived_at FROM harness_shared.agent_chats_consolidated
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND id = ${siblingId}`;
      expect(sibling).toEqual({ title: 'P8 sibling', archived_at: null });
      expect(pane.screen()).not.toContain('sibling history');
      expect(warn.mock.calls.filter(([message]) =>
        typeof message !== 'string' || !message.startsWith('[hnsw-iterative-scan]'))).toEqual([]);
      console.info('PUI_SESSION_LIFECYCLE_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, stored, indexed, frame: pane.screen(),
      }));
    } finally {
      // Stop the PUI BEFORE restoring: its last search can still be in flight
      // in this process's operator and would warn outside the spy (run 30580f8b).
      await pane.stop().catch(() => {});
      warn.mockRestore();
    }
  }, 300_000);
});

describe.skipIf(scriptedEngine.real).sequential('PUI P-009 recovery (spec clauses)', () => {
  // AUTO-BAR-R-06-P-009 — "Every terminal session failure exposes a usable
  // recovery action in PUI within the declared startup deadline." Probe: inject
  // engine death, startup failure, expired auth and stream loss; inspect state
  // transitions and composer access by 15 seconds. Falsifier: "A dead executor
  // or failed stream leaves an indefinite Running/input-locked state."
  const RECOVERY_DEADLINE_MS = 15_000;
  const faults = [
    { mode: 'engine-death', cause: /PUI-E2E engine process died mid-turn/ },
    { mode: 'stream-loss', cause: /event stream closed unexpectedly/ },
    { mode: 'auth-expired', cause: /401 authentication_error/ },
    { mode: 'rate-limit', cause: /rate_limit_error/ },
  ] as const;
  test.for(faults)('AUTO-BAR-R-06-P-009: $mode after acceptance leaves a usable composer within 15s', { timeout: 180_000 }, async ({ mode, cause }, { onTestFailed }) => {
    const prompt = `P9 ${mode} ${randomUUID().slice(0, 8)}`;
    const followUp = `P9 ${mode} follow-up ${randomUUID().slice(0, 8)}`;
    let stage = 'compose';
    let recoveredAfterMs: number | undefined;
    const pane = new PuiPane(bin, operatorPort, home);
    onTestFailed(() => console.info('PUI_R06_RECOVERY_FAILURE', JSON.stringify({
      mode, stage, recoveredAfterMs, requests: scriptedEngine.requests, ...pane.failureEvidence(),
    })));
    try {
      await openComposer(pane);
      scriptedEngine.mode = mode;
      pane.write(prompt);
      pane.enter();
      // t0 is durable acceptance: the engine has the exact prompt.
      stage = 'accepted';
      await vi.waitFor(() => expect(scriptedEngine.requests).toEqual([prompt]), { timeout: 60_000, interval: 50 });
      const acceptedAt = Date.now();

      stage = 'recovery-deadline';
      await vi.waitFor(() => {
        const frame = pane.screen();
        expect(frame).toMatch(cause);
        expect(frame).toContain('Message — Enter send');
        expect(frame).not.toContain('Sending — awaiting acceptance');
      }, { timeout: RECOVERY_DEADLINE_MS, interval: 100 });
      recoveredAfterMs = Date.now() - acceptedAt;
      expect(recoveredAfterMs).toBeLessThanOrEqual(RECOVERY_DEADLINE_MS);

      // The recovery action is usable, not merely rendered: a new message is
      // accepted and executed exactly once, and the failed prompt is never
      // dispatched again (no automatic re-execution of an accepted turn).
      stage = 'use-recovery';
      scriptedEngine.mode = 'success';
      pane.write(followUp);
      await pane.waitFor(followUp);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await vi.waitFor(() => expect(scriptedEngine.requests).toEqual([prompt, followUp]), { timeout: 30_000 });
      const saved = await waitForSavedTurn(followUp);
      expect(saved.transcript.filter((turn) => turn.role === 'user' && turn.content === prompt)).toHaveLength(1);
      // A dead engine is recovered by the production path: an EXACT resume of
      // the same native session, never a fresh one that forgot the turn.
      if (mode === 'engine-death' || mode === 'stream-loss') {
        const [dead, recovery] = scriptedEngine.sdkSessions.slice(-2);
        expect(dead.sessionId).toBeTruthy();
        expect(recovery).toEqual({ resume: dead.sessionId, sessionId: null });
      }
      console.info('PUI_R06_RECOVERY_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, mode, recoveredAfterMs, deadlineMs: RECOVERY_DEADLINE_MS,
        chatId: saved.id, requests: scriptedEngine.requests, frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // The probe's fourth fault. Nothing was accepted, so the clock starts at
  // Enter and the recovery action is the retained draft itself.
  test('AUTO-BAR-R-06-P-009: startup failure leaves the exact draft retryable within 15s', async ({ onTestFailed }) => {
    const prompt = `P9 startup-exit ${randomUUID().slice(0, 8)}`;
    let stage = 'compose';
    let recoveredAfterMs: number | undefined;
    scriptedEngine.mode = 'startup-exit';
    const pane = new PuiPane(bin, operatorPort, home);
    onTestFailed(() => console.info('PUI_R06_RECOVERY_FAILURE', JSON.stringify({
      mode: 'startup-exit', stage, recoveredAfterMs, requests: scriptedEngine.requests, ...pane.failureEvidence(),
    })));
    try {
      await openComposer(pane);
      pane.write(prompt);
      await pane.waitFor(prompt);
      const sentAt = Date.now();
      pane.enter();

      stage = 'recovery-deadline';
      await vi.waitFor(() => {
        const frame = pane.screen();
        expect(frame).toMatch(/PUI-E2E engine exited during initialization|event stream closed unexpectedly/);
        expect(frame).toContain('Message not accepted — draft retained');
        expect(frame).toContain(`> ${prompt}`);
        expect(frame).not.toContain('Sending — awaiting acceptance');
      }, { timeout: RECOVERY_DEADLINE_MS, interval: 100 });
      recoveredAfterMs = Date.now() - sentAt;
      expect(recoveredAfterMs).toBeLessThanOrEqual(RECOVERY_DEADLINE_MS);
      expect(scriptedEngine.requests).toEqual([]);

      stage = 'retry';
      scriptedEngine.mode = 'success';
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect(scriptedEngine.requests).toEqual([prompt]);
      const saved = await waitForSavedTurn(prompt);
      expect(saved.transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      // Nothing native existed to restore, so the retry starts the SAME native
      // id fresh; an exact resume has no transcript and is refused forever.
      const [failed, retried] = scriptedEngine.sdkSessions.slice(-2);
      expect(failed.sessionId).toBeTruthy();
      expect(retried).toEqual({ resume: null, sessionId: failed.sessionId });
      console.info('PUI_R06_RECOVERY_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, mode: 'startup-exit', recoveredAfterMs, deadlineMs: RECOVERY_DEADLINE_MS,
        chatId: saved.id, requests: scriptedEngine.requests, frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 180_000);

  // P-009 "no orphan process after end": the owner's End (Operator tab, `E`)
  // must reach the host as an `end` command, end the session, and take the
  // engine's native process down with it.
  test('P-009 END: ending the session from PUI ends it and leaves no native engine process', async ({ onTestFailed }) => {
    const prompt = `P9 end ${randomUUID().slice(0, 8)}`;
    let stage = 'compose';
    let nativePid: number | null = null;
    scriptedEngine.mode = 'success';
    const enginesBefore = scriptedEngine.engines.length;
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    const pane = new PuiPane(bin, operatorPort, home);
    onTestFailed(() => console.info('PUI_P009_END_FAILURE', JSON.stringify({
      stage, nativePid, alive: nativePid ? alive(nativePid) : null, ...pane.failureEvidence(),
    })));
    try {
      await openComposer(pane);
      pane.write(prompt);
      await pane.waitFor(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect(scriptedEngine.engines.length).toBeGreaterThan(enginesBefore);
      const engine = scriptedEngine.engines.at(-1)!;
      nativePid = engine.pid();
      // Positive control: the process this test will watch exists and is live.
      expect(nativePid).toBeGreaterThan(0);
      expect(alive(nativePid!)).toBe(true);

      stage = 'end';
      pane.escape();
      pane.write('E');
      await vi.waitFor(() => expect(engine.adapter.host.descriptor().lifecycle).toBe('ended'), {
        timeout: 30_000, interval: 100,
      });
      await vi.waitFor(() => expect(alive(nativePid!), `native engine pid ${nativePid} outlived End`).toBe(false), {
        timeout: 15_000, interval: 100,
      });
      await engine.done;
      console.info('PUI_P009_END_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, nativePid, lifecycle: engine.adapter.host.descriptor().lifecycle, frame: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 180_000);
});

describe.skipIf(scriptedEngine.real).sequential('pui SU composer (current binary, real PTY/operator/PG)', () => {
  test('cleanup reports its own failure without replacing an earlier semantic failure', async () => {
    const primary = new Error('same-native identity mismatch');
    const paneCleanup = new Error('pane cleanup failed');
    const operatorCleanup = new Error('operator cleanup failed');
    const reports: Array<Record<string, unknown>> = [];
    const pane = vi.fn(async () => { throw paneCleanup; });
    const operator = vi.fn(async () => { throw operatorCleanup; });

    await preservePrimaryFailureDuringCleanup(
      { error: primary },
      [
        { label: 'pui-pane', run: pane },
        { label: 'operator-process', run: operator },
      ],
      (report) => reports.push(report),
    );

    expect(pane).toHaveBeenCalledOnce();
    expect(operator).toHaveBeenCalledOnce();
    expect(reports).toEqual([{
      primary: 'Error: same-native identity mismatch',
      cleanupFailures: [
        { label: 'pui-pane', error: 'Error: pane cleanup failed' },
        { label: 'operator-process', error: 'Error: operator cleanup failed' },
      ],
    }]);
    await expect(preservePrimaryFailureDuringCleanup(null, [
      { label: 'operator-process', run: async () => { throw operatorCleanup; } },
    ])).rejects.toBe(operatorCleanup);
  });

  test('teardown retains a close failure and still disposes every tracked engine', async () => {
    const failure = new Error('native close failed');
    const first = {
      close: vi.fn(async () => { throw failure; }),
      adapter: { host: { descriptor: () => ({ identity: { ownerId: 'pui-cleanup-failure' } }) }, dispose: vi.fn() },
    };
    const second = {
      close: vi.fn(async () => {}),
      adapter: { host: { descriptor: () => ({ identity: { ownerId: 'pui-cleanup-success' } }) }, dispose: vi.fn() },
    };
    scriptedEngine.engines.push(first as unknown as ClaudeSuEngine, second as unknown as ClaudeSuEngine);
    await expect(stopEngines()).rejects.toMatchObject({ errors: [failure] });
    expect(first.adapter.dispose).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(second.adapter.dispose).toHaveBeenCalledOnce();
    expect(scriptedEngine.engines).toHaveLength(0);
  });

  test('a refused reconnect stays visible without submitting a new owner turn', async () => {
    const pane = new PuiPane(bin, operatorPort, home);
    let saved: PersistedChat;
    try {
      await openComposer(pane);
      const prompt = `saved reconnect ${randomUUID()}`;
      pane.write(prompt); pane.enter();
      // Seeding includes asynchronous session launch. Start the persistence
      // oracle only after the real UI observes its completed turn, as the
      // composer journey below does; its short DB deadline is not a startup
      // deadline. No refusal or reconnect assertion is relaxed.
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      try {
        saved = await waitForSavedTurn(prompt);
      } catch (cause) {
        throw new Error(`Reconnect seed turn did not persist on the rendered screen:\n${pane.screen()}`, { cause });
      }
    } finally { await pane.stop(); }
    await stopEngines();
    await putViewState('Plans');
    transportFault = 'startup-disconnect';
    const reopened = new PuiPane(bin, operatorPort, home);
    try {
      await reopened.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      reopened.write('o');
      // Startup can either restore the just-ended conversation or leave the
      // fresh-session launcher open. Escape exits either transient surface;
      // the same conversation picker below is the reconnect authority.
      await reopened.waitFor('┌ Agent Chat');
      reopened.escape();
      await reopened.waitFor('i type · v speak');
      reopened.write('l');
      await reopened.waitFor('Conversation — Enter select');
      reopened.enter();
      await reopened.waitFor('PUI-E2E startup connection interrupted');
      await reopened.waitFor('choose session to reconnect');
      expect(commandPosts.filter((command) => command.type === 'owner_turn')).toHaveLength(1);
      expect(await persistedChats(db)).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved!.id })]));
      console.info('PUI_RECONNECT_REFUSAL_ACCEPTANCE', JSON.stringify({ binarySha256, chatId: saved!.id,
        screen: reopened.screen(), commands: commandPosts.map((command) => command.type) }));
    } finally { await reopened.stop(); }
  });

  test.each(['missing', 'disabled'] as const)(
    'operator with %s attached capability retains the draft and refuses before any launch',
    async (capability) => {
      attachedCapability = capability;
      const prompt = 'PUI compatibility guard exact draft λ';
      const pane = new PuiPane(bin, operatorPort, home);
      try {
        await openComposer(pane, false);
        pane.write(prompt);
        pane.enter();
        await pane.waitFor('Operator does not support windowless', { timeoutMs: 30_000 });
        pane.escape();
        await pane.waitFor(prompt);
        expect(pane.screen()).toContain(prompt);
        expect(launchRequests).toEqual([]);
        expect(commandPosts).toEqual([]);
        expect(scriptedEngine.requests).toEqual([]);
        expect(nativeTerminalLaunch).not.toHaveBeenCalled();
        // Retrying the retained draft must not fall back to the legacy route.
        pane.enter();
        await pane.waitFor('Operator does not support windowless');
        expect(launchRequests).toEqual([]);
        expect(nativeTerminalLaunch).not.toHaveBeenCalled();
        console.info('PUI_COMPATIBILITY_REFUSAL_ACCEPTANCE', JSON.stringify({
          binary: bin, binarySha256, capability, launchRequests: launchRequests.length,
          nativeTerminalLaunches: nativeTerminalLaunch.mock.calls.length,
          screen: pane.screen(),
        }));
      } finally { await pane.stop(); }
    },
  );

  test('new-session setup refuses an operator without the safe native approval capability', async () => {
    attachedCapability = 'unsafe';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane, false);
      pane.write('retain this draft');
      pane.enter();
      await pane.waitFor('safe native approvals');
      expect(launchRequests).toEqual([]);
      pane.escape();
      await pane.waitFor('retain this draft');
    } finally { await pane.stop(); }
  });

  test('AUTO-BAR-R-04-P-010: new-session setup reviews every effective choice and launches only from Review', async () => {
    const prompt = '  setup exact λ draft  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane, false);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('New SU session — 1 Context');
      expect(launchRequests).toEqual([]);
      pane.write('/');
      pane.write(HARNESS);
      pane.enter();
      await pane.waitFor(`> ${HARNESS}`);
      pane.enter();
      await pane.waitFor('New SU session — 2 Runtime');
      await pane.waitFor('Runtime: Ready', { timeoutMs: 45_000 });
      expect(launchRequests).toEqual([]);
      for (const expected of ['Engine: Claude', 'Account: default', 'Server default model', 'Default effort', 'Mode: Manual']) {
        expect(pane.screen()).toContain(expected);
      }
      pane.enter();
      await pane.waitFor('New SU session — 3 Review');
      expect(pane.screen()).toContain(prompt);
      expect(launchRequests).toEqual([]);
      pane.write('\x1b[Z'); // Back preserves fields.
      await pane.waitFor('New SU session — 2 Runtime');
      pane.enter();
      await pane.waitFor('New SU session — 3 Review');
      expect(pane.screen()).toContain(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect(launchRequests).toEqual([expect.objectContaining({
        attached_engine: true, agent: 'claude', harness_slug: HARNESS, account: 'default',
      })]);
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect(scriptedEngine.sdkPermissions).toEqual([{ mode: 'default', bypass: undefined }]);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      console.info('PUI_SETUP_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, traffic: sessionTraffic }));
    } finally { await pane.stop(); }
  });

  test('new-session setup reconnects with an endpoint-scoped token and preserves the exact draft', async () => {
    const prompt = '  reconnect exact λ draft  ';
    const requiredToken = 'pui-fixture-new-operator';
    const credentials: Array<string | undefined> = [];
    const proxy = createServer((req, res) => {
      credentials.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${requiredToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'operator token required' }));
        return;
      }
      const upstream = httpRequest(`http://127.0.0.1:${operatorPort}${req.url ?? '/'}`, {
        method: req.method, headers: req.headers,
      }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    const proxyPort = await listen(proxy);
    const pane = new PuiPane(bin, operatorPort, home, { operatorToken: 'pui-fixture-old-operator' });
    try {
      await openComposer(pane, false);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('New SU session — 1 Context');
      pane.write('e');
      await pane.waitFor('Operator connection');
      pane.write('\x15'); // Ctrl-U clears the address.
      pane.write(`http://127.0.0.1:${proxyPort}`);
      pane.enter();
      await pane.waitFor('Connection: Unavailable');
      expect(credentials.length).toBeGreaterThan(0);
      expect(credentials.every((token) => token === undefined)).toBe(true);
      expect(launchRequests).toEqual([]);
      pane.write('e');
      await pane.waitFor('Operator connection');
      pane.write('\t');
      pane.write(requiredToken);
      await pane.waitFor('••••••••');
      expect(pane.screen()).not.toContain(requiredToken);
      pane.enter(); // Finish token entry; reconnect still needs confirmation.
      await pane.waitFor('Credential entered');
      expect(launchRequests).toEqual([]);
      pane.enter();
      await pane.waitFor('Connection: Connected');
      expect(credentials).toContain(`Bearer ${requiredToken}`);
      expect(pane.screen()).not.toContain(requiredToken);
      await completeNewSessionSetup(pane);
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();
      console.info('PUI_SETUP_RECONNECT_ACCEPTANCE', JSON.stringify({ binarySha256,
        refusedWithoutCredential: true, oldCredentialForwarded: false, draftPreserved: true }));
    } finally { await pane.stop(); await close(proxy); }
  });

  test('AUTO-BAR-R-08-P-010: new-session setup is reachable from a clean workbench with no running operator', async () => {
    const unused = createServer();
    const closedPort = await listen(unused);
    await close(unused);
    const cleanHome = mkdtempSync(path.join(tmpdir(), 'pui-onboarding-clean-'));
    const pane = new PuiPane(bin, closedPort, cleanHome, { args: ['workbench'], cols: 80, rows: 20 });
    try {
      await pane.waitFor('New SU session — 1 Context', { timeoutMs: 20_000 });
      await pane.waitFor('Connection: Unavailable');
      pane.enter();
      expect(launchRequests).toEqual([]);
      pane.write('e');
      await pane.waitFor('Operator connection');
      pane.write('\x15');
      pane.write(`http://127.0.0.1:${operatorPort}`);
      pane.enter();
      await pane.waitFor('Connection: Connected');
      await completeNewSessionSetup(pane);
      await pane.waitFor('Message — Enter send', { timeoutMs: 60_000 });
      expect(launchRequests).toHaveLength(1);
      expect(scriptedEngine.requests).toEqual([]);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();
    } finally { await pane.stop(); rmSync(cleanHome, { recursive: true, force: true }); }
  });

  test('AUTO-BAR-R-08-P-010: new-session setup registers a project from an empty registry and clean profile', async () => {
    const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
    const savedRegistry = await loadHarnessRegistry(WORKSPACE);
    const projectSlug = `onboarding-${randomUUID().slice(0, 8)}`;
    const projectPath = mkdtempSync(path.join(home, 'new-owner-project-'));
    const cleanHome = mkdtempSync(path.join(home, 'new-owner-profile-'));
    writeFileSync(path.join(projectPath, 'README.md'), '# Newly registered project\n');
    await saveHarnessRegistry({ projects: [] }, WORKSPACE, { allowEmpty: true });
    const pane = new PuiPane(bin, operatorPort, cleanHome, { args: ['hud'] });
    try {
      await pane.waitFor('Welcome to pui');
      pane.escape();
      await pane.waitFor('New SU session — 1 Context');
      await pane.waitFor('Connection: Connected');
      await pane.waitFor('No matching projects');
      expect(launchRequests).toEqual([]);
      pane.write('c');
      await pane.waitFor('Register project');
      pane.write(projectSlug);
      pane.enter();
      pane.write(projectPath);
      pane.enter();
      await pane.waitFor('REGISTER PROJECT');
      expect((await loadHarnessRegistry(WORKSPACE)).projects).toEqual([]);
      expect(launchRequests).toEqual([]);
      pane.enter();
      await pane.waitFor('Project registered', { timeoutMs: 60_000 });
      expect((await loadHarnessRegistry(WORKSPACE)).projects).toEqual([
        expect.objectContaining({ slug: projectSlug, path: projectPath }),
      ]);
      expect(launchRequests).toEqual([]);
      pane.enter();
      await pane.waitFor('Runtime: Ready', { timeoutMs: 45_000 });
      pane.enter();
      await pane.waitFor('New SU session — 3 Review');
      expect(pane.screen()).toContain(projectSlug);
      expect(pane.screen()).toContain('Permissions: native approval prompts');
      pane.enter();
      await pane.waitFor('Message — Enter send', { timeoutMs: 60_000 });
      expect(launchRequests).toEqual([expect.objectContaining({ harness_slug: projectSlug, account: 'default' })]);
      expect(scriptedEngine.requests).toEqual([]);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();
      console.info('PUI_EMPTY_REGISTRY_ONBOARDING_ACCEPTANCE', JSON.stringify({ binarySha256,
        projectSlug, registryInitiallyEmpty: true, nativeTerminalLaunches: 0 }));
    } finally {
      await pane.stop();
      await stopEngines();
      await saveHarnessRegistry(savedRegistry, WORKSPACE);
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(cleanHome, { recursive: true, force: true });
    }
  });

  // PUI-BASELINE (P-001) counterexample, never a release journey. It runs only
  // with PUI_CAPTURE_BASELINE=1 and PUI_BIN naming a binary built from the
  // pre-fix source:
  //   git archive 7b87064faa apps/tui apps/pui-companion-proto | tar -x -C "$D"
  //   (cd "$D/apps/tui" && CARGO_TARGET_DIR="$D/target" cargo build --locked)
  // That binary launched a deferred native pane (defer_spawn) with no attached
  // engine, so the first draft never reached an SU command or an engine and no
  // reply could stream. The launch trace is what tells that apart from a slow
  // or silent engine. Against the current binary this test must FAIL; that is
  // its calibration, and the journey below is the fixed behaviour.
  test.runIf(process.env.PUI_CAPTURE_BASELINE === '1')(
    'PUI-BASELINE: a pre-fix first submit launches a deferred native pane and never reaches an engine',
    async ({ onTestFailed }) => {
      const prompt = `PUI-BASELINE-${Date.now()}`;
      const pane = new PuiPane(bin, operatorPort, home);
      onTestFailed(() => console.info('PUI_BASELINE_FAILURE', JSON.stringify({ binarySha256, launchRequests,
        traffic: sessionTraffic, commandPosts: commandPosts.length, engineRequests: scriptedEngine.requests.length,
        nativeTerminalLaunches: nativeTerminalLaunch.mock.calls.length, ...pane.failureEvidence() })));
      try {
        // The pre-fix key path: the global Agent Chat action, leave the
        // restored composer, then type through PUI's own composer.
        await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        pane.write('o');
        await pane.waitFor(`pot ${HARNESS} · role operator · session new`);
        pane.escape();
        await pane.waitFor('i type · v speak');
        pane.write('i');
        // Only the current binary shows the New SU session form. Completing it
        // lets the calibration run reach its launch and fail on the trace
        // below, not on a launch that never happened.
        pane.reviewNextNewSession();
        pane.write(prompt);
        pane.enter();
        await vi.waitFor(() => {
          expect(sessionTraffic.some((entry) => entry.path === '/api/adv/sessions/launch-su')).toBe(true);
        }, { timeout: 30_000, interval: 250 });
        // Give an attached engine every chance to answer before judging silence.
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        expect(pane.screen()).toContain(prompt);
        expect(sessionTraffic).toEqual(expect.arrayContaining([
          expect.objectContaining({ method: 'POST', path: '/api/adv/sessions/launch-su', status: 200,
            deferSpawn: true, attachedEngine: false, nativeSessionPresent: false }),
        ]));
        expect(commandPosts).toHaveLength(0);
        expect(scriptedEngine.requests).toHaveLength(0);
        expect(pane.screen()).not.toContain(scriptedEngine.successText);
        console.info('PUI_BASELINE_COUNTEREXAMPLE', JSON.stringify({ binary: bin, binarySha256, prompt, launchRequests,
          traffic: sessionTraffic, nativeTerminalLaunches: nativeTerminalLaunch.mock.calls.length, screen: pane.screen() }));
      } finally { await pane.stop().catch(() => {}); }
    }, 120_000);

  test('first exact draft reaches the structured SU engine, streams tools/reply, and reopens', async () => {
    const prompt = '  PUI exact Unicode draft λ 雪  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      expect(pane.screen()).toContain('Read');
      expect(pane.screen().split('PUI exact Unicode draft')).toHaveLength(2);
      expect(pane.screen().split(scriptedEngine.successText)).toHaveLength(2);
      expect(scriptedEngine.requests).toEqual([prompt]);
      const chat = await waitForSavedTurn(prompt);
      expect(chat.role).toBe('operator');
      expect(chat.transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      expect(commandPosts).toHaveLength(1);
      expect(commandPosts[0]).toMatchObject({ type: 'owner_turn', content: prompt });
      expect(commandReplies).toEqual([{ status: 202, replayed: false }]);
      expect(sessionTraffic).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/api/adv/sessions/launch-su', status: 200,
          attachedEngine: true, transport: 'structured', nativeSessionPresent: true }),
      ]));
      // The test peer never opens a native terminal. PUI requested only the
      // attached-engine path and the protocol peer received the exact draft.
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')).toHaveLength(1);
      expect(launchRequests).toEqual([expect.objectContaining({ attached_engine: true })]);
      expect(nativeTerminalLaunch).not.toHaveBeenCalled();
      expect(pane.screen()).not.toContain(`> ${prompt}`);
      await pane.stop();
      await putViewState('Plans');
      const reopened = new PuiPane(bin, operatorPort, home);
      try {
        await reopened.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        reopened.write('o');
        await reopened.waitFor(prompt.trim(), { timeoutMs: 30_000 });
        await reopened.waitFor(scriptedEngine.successText);
        expect(reopened.screen().split('PUI exact Unicode draft')).toHaveLength(2);
        expect(reopened.screen().split(scriptedEngine.successText)).toHaveLength(2);
      } finally { await reopened.stop(); }
      expect(namedQueryRequests).not.toContain('network.board');
      expect(pipelineCellRequests).toEqual([]);
      console.info('PUI_COMPOSER_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256,
        chatId: chat.id, exactText: scriptedEngine.requests[0], traffic: sessionTraffic }));
    } finally { await pane.stop().catch(() => {}); }
  });

  // P-012 'Editable task list' (plan D-019). The conversation and its SU session
  // are created by PUI itself; the owner drives the canonical list with the
  // Context keys; the attached agent reads and updates the SAME list through the
  // production MCP route under the SU identity its launch was given. LISTEN is
  // off in this fixture, so the agent update is pulled with `g` (the documented
  // refresh), not pushed.
  test('PUI-TASK: an SU-session task list is edited in Context by owner and agent and survives restart', async ({ onTestFailed }) => {
    const prompt = 'PUI task journey kickoff';
    let stage = 'launch';
    let pane: PuiPane | undefined;
    onTestFailed(() => console.info('PUI_TASK_FAILURE', JSON.stringify({ stage, ...(pane?.failureEvidence() ?? {}) })));
    type TaskRow = { task_id: string; content: string; active_form: string; status: string; blocker_ref: string | null };
    const rows = (sessionId: string) => db.adminSql<TaskRow[]>`
      SELECT task_id, content, active_form, status, blocker_ref FROM harness_shared.session_tasks
       WHERE workspace_id = ${WORKSPACE} AND session_id = ${sessionId} ORDER BY position`;
    type LinkRow = { task_id: string; relation: string; work_item_id: string };
    const links = (sessionId: string) => db.adminSql<LinkRow[]>`
      SELECT task_id, relation, work_item_id FROM harness_shared.session_task_work_item_links
       WHERE workspace_id = ${WORKSPACE} AND session_id = ${sessionId}`;
    const settled = async (sessionId: string, check: (tasks: TaskRow[]) => void) => {
      await vi.waitFor(async () => check(await rows(sessionId)), { timeout: 15_000, interval: 150 });
    };
    // PUI ignores task keys while a mutation is in flight and says "saving…",
    // so the next key waits for the canonical projection, as a person would.
    const ownerKey = async (target: PuiPane, key: string, sessionId: string, check: (tasks: TaskRow[]) => void) => {
      target.write(key);
      await settled(sessionId, check);
      await target.waitForGone('saving…');
    };
    const contextFocus = async (target: PuiPane) => {
      target.escape();
      target.resize(100, 30);
      await target.waitForGone('Context · Ctrl-T');
      target.write('\x14');
      await target.waitFor('Esc/o Agent Chat');
    };
    const { readSuperuserToken } = await import('../superuser-token');
    const agentTasks = async (ownerId: string, args: Record<string, unknown>) => {
      const url = `http://127.0.0.1:${operatorPort}/api/mcp?superuser=1&workspace=${WORKSPACE}`
        + `&harness=${HARNESS}&client=${encodeURIComponent(ownerId)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${readSuperuserToken()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
          params: { name: 'tasks:ops', arguments: args } }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).at(-1)!
        : text;
      const result = (JSON.parse(body) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
      expect(result.isError, result.content[0]?.text).not.toBe(true);
      return JSON.parse(result.content[0].text) as { sessionId: string; tasks: Array<{ id: string; content: string; status: string }> };
    };

    pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      const chat = await waitForSavedTurn(prompt);
      const [binding] = await db.adminSql<Array<{ coord_owner_id: string; su_runtime_class: string }>>`
        SELECT adv.coord_owner_id, chat.su_runtime_class
          FROM harness_shared.adv_sessions adv
          JOIN harness_shared.agent_chats_consolidated chat
            ON chat.workspace_id = adv.workspace_id AND chat.id = adv.su_agent_chat_id
         WHERE adv.workspace_id = ${WORKSPACE} AND adv.su_agent_chat_id = ${chat.id}`;
      expect(binding).toMatchObject({ su_runtime_class: 'su-session' });
      const ownerId = binding.coord_owner_id;
      expect(ownerId).not.toBe(chat.id);

      stage = 'agent-init';
      const init = await agentTasks(ownerId, { op: 'init', tasks: [
        { content: 'Draft the release notes', activeForm: 'Drafting the release notes' },
        { content: 'Verify the installer', activeForm: 'Verifying the installer' },
      ] });
      expect(init.sessionId).toBe(chat.id);
      const [notes, installer] = init.tasks.map((task) => task.id);

      stage = 'context';
      await contextFocus(pane);
      await pane.waitFor('Draft the release notes', { timeoutMs: 30_000 });
      await pane.waitFor('Verify the installer');

      stage = 'owner-edit';
      pane.write('e');
      await pane.waitFor('Edit task > Draft the release notes');
      pane.write('\x15');
      pane.write('Draft the public release notes');
      pane.enter();
      await pane.waitForGone('Edit task >');
      await settled(chat.id, (tasks) => expect(tasks[0]).toMatchObject({ task_id: notes, content: 'Draft the public release notes' }));

      stage = 'owner-status';
      await ownerKey(pane, 's', chat.id, (tasks) => expect(tasks[0]).toMatchObject({ task_id: notes, status: 'in_progress' }));
      pane.write('b');
      await pane.waitFor('Block task on >');
      // Short enough to render on one row of the 100-column Context rail; a
      // longer reason wraps, and waitFor matches contiguous screen text.
      pane.write('owner review');
      pane.enter();
      await settled(chat.id, (tasks) => expect(tasks[0]).toMatchObject({ status: 'blocked', blocker_ref: 'owner review' }));
      await pane.waitFor('blocked on owner review');
      await pane.waitForGone('saving…');
      await ownerKey(pane, 'u', chat.id, (tasks) => expect(tasks[0]).toMatchObject({ task_id: notes, blocker_ref: null }));
      await ownerKey(pane, 'x', chat.id, (tasks) => expect(tasks[0]).toMatchObject({ task_id: notes, status: 'completed' }));
      await ownerKey(pane, 'r', chat.id, (tasks) => expect(tasks[0]).toMatchObject({ task_id: notes, status: 'pending' }));

      stage = 'agent-update';
      // The agent sees the owner's edits on the same stable ids, then updates one.
      const seen = await agentTasks(ownerId, { op: 'view' });
      expect(seen.tasks.map(({ id, content, status }) => ({ id, content, status }))).toEqual([
        { id: notes, content: 'Draft the public release notes', status: 'pending' },
        { id: installer, content: 'Verify the installer', status: 'pending' },
      ]);
      await agentTasks(ownerId, { op: 'start', task_id: installer, explanation: 'Agent is verifying the installer' });
      pane.write('g');
      await pane.waitFor('Agent is verifying the installer', { timeoutMs: 30_000 });

      stage = 'owner-reorder';
      await ownerKey(pane, 'J', chat.id, (tasks) => expect(tasks.map((task) => task.task_id)).toEqual([installer, notes]));
      // Selection stays on the row index, so step onto the moved task before K.
      pane.write('j');
      await ownerKey(pane, 'K', chat.id, (tasks) => expect(tasks.map((task) => task.task_id)).toEqual([notes, installer]));

      stage = 'owner-promote';
      // Selection stayed on row 1, the installer. No session claim seeds a
      // link, so Shift-P is the only thing that can create one.
      expect(await links(chat.id)).toEqual([]);
      pane.write('P');
      await vi.waitFor(async () => expect(await links(chat.id)).toEqual([
        expect.objectContaining({ task_id: installer, relation: 'for' }),
      ]), { timeout: 15_000, interval: 150 });
      await pane.waitForGone('saving…');
      const [promoted] = await links(chat.id);
      const [workItem] = await db.adminSql<Array<{ item_kind: string; title: string }>>`
        SELECT item_kind, title FROM harness_shared.work_items
         WHERE workspace_id = ${WORKSPACE} AND feature_id = ${promoted.work_item_id}`;
      expect(workItem).toMatchObject({ item_kind: 'task', title: 'Verify the installer' });
      await pane.waitFor(`evidence ${promoted.work_item_id} (for)`);
      // Promotion links the task; it keeps its id, place and status.
      expect((await rows(chat.id)).map(({ task_id, status }) => ({ task_id, status }))).toEqual([
        { task_id: notes, status: 'pending' },
        { task_id: installer, status: 'in_progress' },
      ]);
      const promoteFrame = pane.screen();

      stage = 'owner-add-drop';
      pane.write('a');
      await pane.waitFor('Add task >');
      pane.write('Added entirely in PUI');
      pane.enter();
      await pane.waitForGone('Add task >');
      await settled(chat.id, (tasks) => expect(tasks.map((task) => task.content)).toContain('Added entirely in PUI'));
      pane.write('kkkk');
      await ownerKey(pane, 'd', chat.id, (tasks) => expect(tasks.find((task) => task.task_id === notes)?.status).toBe('dropped'));
      const final = await rows(chat.id);
      expect(final.map(({ content, status }) => ({ content, status }))).toEqual(expect.arrayContaining([
        { content: 'Draft the public release notes', status: 'dropped' },
        { content: 'Verify the installer', status: 'in_progress' },
        { content: 'Added entirely in PUI', status: 'pending' },
      ]));
      expect(final).toHaveLength(3);
      // The agent's own session key holds nothing: both halves wrote one list.
      expect(await rows(ownerId)).toEqual([]);
      const frame = pane.screen();
      await pane.stop();

      stage = 'restart';
      await putViewState('Plans');
      pane = new PuiPane(bin, operatorPort, home);
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      await pane.waitFor(prompt, { timeoutMs: 30_000 });
      await contextFocus(pane);
      await pane.waitFor('Added entirely in PUI', { timeoutMs: 30_000 });
      const reloaded = pane.screen();
      // Context labels an in-progress task by its active form (plans_board.rs).
      const order = final.map((task) => reloaded.indexOf(task.status === 'in_progress' ? task.active_form : task.content));
      expect(order.every((at) => at >= 0), reloaded).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(reloaded).toContain(`evidence ${promoted.work_item_id} (for)`);
      expect(await links(chat.id)).toEqual([promoted]);
      console.info('PUI_TASK_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, chatId: chat.id,
        suOwnerId: ownerId, tasks: final, frame, reloadedFrame: reloaded }));
      console.info('PUI_TASK_PROMOTE_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, chatId: chat.id,
        taskId: installer, link: promoted, workItem, promoteFrame, reloadedFrame: reloaded }));
    } finally { await pane?.stop().catch(() => {}); }
  }, 240_000);

  test('PUI-SETTINGS-PICKERS: live pickers name defaults and reasons, and a launch-time pick on a running conversation opens a new session', async ({ onTestFailed }) => {
    const prompt = 'PUI settings journey kickoff';
    let stage = 'inventory';
    let pane: PuiPane | undefined;
    onTestFailed(() => console.info('PUI_SETTINGS_FAILURE', JSON.stringify({ stage, ...(pane?.failureEvidence() ?? {}) })));
    const { readSuperuserToken } = await import('../superuser-token');
    const served = await fetch(`http://127.0.0.1:${operatorPort}/api/agent-config`,
      { headers: { authorization: `Bearer ${readSuperuserToken()}` } });
    expect(served.status).toBe(200);
    const config = await served.json() as {
      effectiveTiers: Array<{ name: string; spec: string; loopCapability?: { executable?: boolean } }>;
      effortLevels: string[];
      launchableModes: Array<{ title: string }>;
    };
    expect(config.effectiveTiers.length).toBeGreaterThan(0);
    const disabledTiers = config.effectiveTiers.filter((tier) => tier.loopCapability?.executable === false);
    const launches = () => sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')
      .reduce((total, entry) => total + Number(entry.count ?? 1), 0);

    pane = new PuiPane(bin, operatorPort, home);
    try {
      stage = 'launch';
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      const chat = await waitForSavedTurn(prompt);
      pane.escape();
      await pane.waitFor('i type · v speak');
      // The overlay is 60% of the terminal; give long tier labels room.
      pane.resize(160, 48);
      const picker = async (target: PuiPane, key: string, title: string, rows: string[]) => {
        target.write(key);
        await target.waitFor(`${title} — Enter select`);
        for (const row of rows) await target.waitFor(row);
        const frame = target.screen();
        target.escape();
        await target.waitForGone(`${title} — Enter select`);
        return frame;
      };

      stage = 'pickers';
      // Every row comes from the operator's own inventory; the default row is
      // named and an unsupported tier stays visible with its reason.
      const frames = {
        model: await picker(pane, 'm', 'Model', ['Default (',
          ...config.effectiveTiers.map((tier) => `${tier.name} — ${tier.spec}`),
          ...disabledTiers.map((tier) => `${tier.name} — ${tier.spec} — not settable`),
          ...(disabledTiers.length > 0 ? ['not executable by Agent Chat loop'] : [])]),
        effort: await picker(pane, 'e', 'Effort', ['Model/default effort', ...config.effortLevels]),
        account: await picker(pane, 'a', 'Account route', ['Auto (gateway routing)', 'Default system account']),
        mode: await picker(pane, 'u', 'Launch mode', ['Manual (no launch mode)', ...config.launchableModes.map((mode) => mode.title)]),
        conversation: await picker(pane, 'l', 'Conversation', []),
      };
      for (const frame of Object.values(frames)) expect(frame).not.toContain(readSuperuserToken());

      stage = 'restart-required-pick';
      const executable = config.effectiveTiers.findIndex((tier) => tier.loopCapability?.executable !== false);
      expect(executable).toBeGreaterThanOrEqual(0);
      const before = launches();
      pane.write('m');
      await pane.waitFor('Model — Enter select');
      pane.write('j'.repeat(executable + 1));
      pane.enter();
      await pane.waitFor('New SU session — 1 Context');
      await pane.waitFor('Applies to a new session');
      const routeFrame = pane.screen();
      expect(launches()).toBe(before);
      pane.escape();
      await pane.waitForGone('New SU session');
      await pane.waitFor(prompt);
      // Nothing launched; the running conversation keeps its one SU session.
      expect(launches()).toBe(before);
      const [binding] = await db.adminSql<Array<{ sessions: number }>>`
        SELECT count(*)::int AS sessions FROM harness_shared.adv_sessions
         WHERE workspace_id = ${WORKSPACE} AND su_agent_chat_id = ${chat.id}`;
      expect(binding.sessions).toBe(1);
      console.info('PUI_SETTINGS_PICKERS_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, chatId: chat.id,
        servedTiers: config.effectiveTiers.map((tier) => tier.spec), disabledTiers: disabledTiers.map((tier) => tier.spec),
        pickedTier: config.effectiveTiers[executable].spec, frames, routeFrame }));
    } finally { await pane?.stop().catch(() => {}); }
  }, 240_000);

  test('PUI-ABOUT-SUPPORT: palette About shows identity and Diagnostics previews and saves a redacted report', async ({ onTestFailed }) => {
    // Secret-shaped and PUI_-prefixed, so Diagnostics lists it and must redact it.
    const secret = `pui-about-fixture-${randomUUID()}`;
    const installed = Boolean(process.env.PUI_BIN);
    // About verifies the release the store names as current. A user's PUI reads
    // the store it was installed into; the suite's own HOME has an empty one, so
    // an installed run points PUI_HOME at the store release-acceptance wrote.
    const store = process.env.PUI_RELEASE_STORE;
    if (installed && !store) throw new Error('PUI_BIN needs PUI_RELEASE_STORE; run it through apps/tui/scripts/release-acceptance.sh');
    const pane = new PuiPane(bin, operatorPort, home, {
      cols: 160, rows: 48, env: { PUI_ABOUT_FIXTURE_TOKEN: secret, ...(store ? { PUI_HOME: store } : {}) },
    });
    onTestFailed(() => console.info('PUI_ABOUT_SUPPORT_FAILURE', JSON.stringify(pane.failureEvidence())));
    const palette = async (command: string, title: string) => {
      pane.write(':');
      await pane.waitFor('Command (Esc closes)');
      pane.write(command);
      pane.enter();
      await pane.waitFor(title);
    };
    try {
      await pane.waitFor('?:help', { timeoutMs: 40_000 });
      await palette('about', 'About PUI');
      await pane.waitFor(' · source ');
      await pane.waitFor('update channel: ');
      await pane.waitFor(`operator endpoint: http://127.0.0.1:${operatorPort}`);
      // A release install names its release and verification; a dev build says
      // it is not one, and the release reporter only accepts the installed sha.
      if (installed) {
        await pane.waitFor('running release: ');
        await pane.waitFor('(verified)');
      } else {
        await pane.waitFor('installed from a source checkout');
      }
      const about = pane.screen();
      pane.escape();
      await pane.waitForGone('About PUI');

      await palette('diagnostics', 'PUI diagnostics (redacted');
      await pane.waitFor('y saves this report to a file');
      const preview = pane.screen();
      expect(preview).not.toContain(secret);
      pane.write('y');
      const saved = await vi.waitFor(() => {
        const match = /✓ saved (\S+)/.exec(pane.screen());
        expect(match).not.toBeNull();
        return match![1];
      }, { timeout: 15_000, interval: 150 });
      const report = readFileSync(saved, 'utf8');
      expect(report).toContain('PUI diagnostics (redacted');
      expect(report).toContain('env PUI_ABOUT_FIXTURE_TOKEN=[redacted]');
      expect(report).not.toContain(secret);
      console.info('PUI_ABOUT_SUPPORT_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, installed,
        about, preview, savedReport: saved, report }));
    } finally { await pane.stop(); }
  }, 120_000);

  test('Network loads on navigation, manual refresh, and saved-view restoration', async () => {
    const pane = new PuiPane(bin, operatorPort, home);
    const networkReads = () => namedQueryReplies.filter((reply) => reply.name === 'network.board' && reply.status === 200).length;
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      expect(namedQueryRequests).not.toContain('network.board');
      pane.write('n');
      await pane.waitFor('Network');
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(0), { timeout: 30_000 });
      const beforeRefresh = networkReads();
      pane.write('g');
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(beforeRefresh), { timeout: 30_000 });
    } finally { await pane.stop(); }
    await putViewState('Network');
    const beforeRestore = networkReads();
    const restored = new PuiPane(bin, operatorPort, home);
    try {
      await restored.waitFor('Network', { timeoutMs: 40_000 });
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(beforeRestore), { timeout: 30_000 });
    } finally { await restored.stop(); }
  });

  test('delayed readiness sends the first draft once and accepts a follow-up after completion', async () => {
    let releaseInitialization!: () => void;
    scriptedEngine.initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const prompt = '  PUI delayed startup draft λ  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('· starting ·', { timeoutMs: 60_000 });
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(pane.screen()).not.toContain('Message not accepted');
      expect(commandPosts).toHaveLength(0);
      expect(scriptedEngine.requests).toHaveLength(0);
      releaseInitialization();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      expect(commandPosts).toHaveLength(1);
      expect(commandPosts[0]).toMatchObject({ type: 'owner_turn', content: prompt });
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')).toHaveLength(1);
      const followup = 'PUI follow-up after waiting-for-owner';
      scriptedEngine.successText = 'PUI follow-up completed';
      pane.write(followup);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText);
      await pane.waitFor('Message — Enter send');
      expect(scriptedEngine.requests).toEqual([prompt, followup]);
      expect(commandPosts).toHaveLength(2);
      expect((await waitForSavedTurn(followup)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(2);
    } finally {
      releaseInitialization();
      await pane.stop();
    }
  });

  test('delivery receipt and assistant segment keep input locked until interruption completes', async () => {
    scriptedEngine.mode = 'stall';
    const prompt = 'PUI pending tool turn';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('PUI tool is still running', { timeoutMs: 60_000 });
      // The running-state bar read " Running — input locked " until P-007 draft
      // queuing made Enter QUEUE the next message instead of being swallowed
      // (ui.rs:3126, pinned there by `assert!(!text.contains("input locked"))`).
      // This waits for the running state; the assertion that input is not
      // send-ready is the `not.toContain('Message — Enter send')` below.
      await pane.waitFor('Running — Enter queues your next message');
      await pane.waitFor('Bash');
      expect(pane.screen()).not.toContain('Message — Enter send');
      await waitForSavedTurn(prompt);
      pane.interrupt();
      await pane.waitFor('Message — Enter send');
      expect(commandPosts.some((command) => command.type === 'interrupt')).toBe(true);
      scriptedEngine.mode = 'success';
      const followup = 'PUI continued after interrupt';
      pane.write(followup);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText);
      await pane.waitFor('Message — Enter send');
      expect(scriptedEngine.requests).toEqual([prompt, followup]);
    } finally { await pane.stop(); }
  });

  test('interrupted startup retains the draft and retries without creating another chat', async () => {
    transportFault = 'startup-disconnect';
    const prompt = '  PUI startup retry λ  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      // The composer soft-wraps the operator error; read it as one paragraph.
      expect(paneContains(pane.screen(), 'Message not accepted', 'PUI-E2E startup connection interrupted'), pane.screen()).toBe(true);
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(commandPosts).toHaveLength(0);
      const chats = await persistedChats(db);
      expect(chats).toHaveLength(1);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect((await waitForSavedTurn(prompt)).id).toBe(chats[0].id);
      expect(await persistedChats(db)).toHaveLength(1);
      expect(scriptedEngine.requests).toEqual([prompt]);
    } finally { await pane.stop(); }
  });

  test('engine startup exit releases input while preserving the exact unsent draft', async () => {
    scriptedEngine.mode = 'startup-exit';
    const prompt = 'PUI failed engine startup';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      // Draft retention alone is insufficient: the failure cause must survive
      // both live delivery and a terminal snapshot followed by stream replay.
      // Generic readiness copy loses the cause and cannot satisfy this guard.
      await vi.waitFor(() => {
        expect(pane.screen()).toMatch(
          /PUI-E2E engine exited during initialization|Claude event stream closed unexpectedly/,
        );
      }, { timeout: 30_000, interval: 100 });
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(pane.screen()).not.toContain('Sending — awaiting acceptance');
      expect(scriptedEngine.requests).toHaveLength(0);
      expect(commandPosts).toHaveLength(0);
      expect((await persistedChats(db))[0].transcript).toHaveLength(0);
    } finally { await pane.stop(); }
  });

  test('host refusal retains an editable draft and a ready retry commits it once', async () => {
    transportFault = 'refuse';
    const prompt = '  PUI refused exact draft  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(commandReplies[0].status).toBe(409);
      expect(scriptedEngine.requests).toHaveLength(0);
      expect((await persistedChats(db))[0].transcript).toHaveLength(0);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 30_000 });
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
    } finally { await pane.stop(); }
  });

  // AUTO-BAR-R-02-P-009 — "Recovery reconciles an uncertain accepted turn
  // without automatically dispatching another execution." Falsifier: "Losing
  // the acceptance response produces duplicate model turns or tool execution."
  test.each(['lost-ack', 'wrong-command-ack', 'wrong-session-ack'] as const)(
    'AUTO-BAR-R-02-P-009: %s keeps the draft and replays the exact persisted command without a second model turn or tool execution', async (fault) => {
      transportFault = fault;
      const prompt = `  PUI ${fault} λ  `;
      const pane = new PuiPane(bin, operatorPort, home);
      try {
        await openComposer(pane);
        pane.write(prompt);
        pane.enter();
        await pane.waitFor('Delivery uncertain', { timeoutMs: 60_000 });
        expect(pane.screen()).toContain(`> ${prompt}`);
        await pane.waitFor(scriptedEngine.successText);
        await vi.waitFor(() => expect(scriptedEngine.requests).toEqual([prompt]));
        const chat = await waitForSavedTurn(prompt);
        expect(chat.transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
        transportFault = 'none';
        pane.enter();
        await pane.waitFor('Message — Enter send');
        expect(pane.screen()).not.toContain(`> ${prompt}`);
        expect(commandPosts).toHaveLength(2);
        expect(commandPosts[1]).toEqual(commandPosts[0]);
        expect(commandReplies[1]).toEqual({ status: 202, replayed: true });
        expect(scriptedEngine.requests).toEqual([prompt]);
        expect((await persistedChats(db))[0].transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
        // Tool identity: the accepted turn's one scripted Read ran exactly once
        // across the loss AND the replay — one start, one completion, one callId.
        const toolEvents = scriptedEngine.events.filter(
          (event): event is Extract<SuSessionEvent, { type: 'tool' }> => event.type === 'tool');
        const started = toolEvents.filter((event) => event.phase === 'started');
        expect(started.map((event) => event.name)).toEqual(['Read']);
        expect(toolEvents.filter((event) => event.phase === 'completed').map((event) => event.callId))
          .toEqual([started[0].callId]);
      } finally { await pane.stop(); }
    },
  );

  test('canonical-identity mismatch fails quickly with an actionable visible error', async () => {
    const proxy = createServer(async (req, res) => {
      try {
        const target = `http://127.0.0.1:${operatorPort}${req.url ?? '/'}`;
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const upstream = await fetch(target, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: body.length ? Buffer.concat(body) : undefined,
          duplex: body.length ? 'half' : undefined,
        } as RequestInit & { duplex?: 'half' });
        let payload = Buffer.from(await upstream.arrayBuffer());
        if ((req.url ?? '').startsWith('/api/tui/identity')) {
          const identity = JSON.parse(payload.toString()) as { agentChat: { scope: string } };
          identity.agentChat.scope = 'workspace:intentionally-wrong';
          payload = Buffer.from(JSON.stringify(identity));
        }
        const headers = Object.fromEntries(upstream.headers.entries());
        delete headers['content-length'];
        headers['content-length'] = String(payload.byteLength);
        res.writeHead(upstream.status, headers);
        res.end(payload);
      } catch {
        // The pui deliberately exits as soon as the identity mismatch is
        // rendered. Its concurrent background reads can therefore disconnect
        // while this proxy still awaits the canonical operator response.
        if (!res.writableEnded) res.destroy();
      }
    });
    const proxyPort = await listen(proxy);
    const pane = new PuiPane(bin, proxyPort, home);
    try {
      await pane.waitFor('operator identity-mismatch', { timeoutMs: 12_000 });
    } finally {
      await pane.stop();
      await close(proxy);
    }
  });
});

/**
 * The manifest the installed PUI itself reads (install.rs default_manifest_path):
 * PUI_INSTALL_MANIFEST, else the release unit the binary runs from, else
 * ~/.papercusp. HOME here is the runner's, so skipping the release step would
 * read the developer's own install. Artifact paths are relative to the manifest
 * (install.rs resolve_manifest_artifact).
 */
function installedManifest(): Record<string, unknown> {
    const releaseManifest = path.join(path.dirname(path.dirname(realpathSync(bin))), 'pui-install.json');
    const manifestPath = process.env.PUI_INSTALL_MANIFEST
      ?? (existsSync(releaseManifest) ? releaseManifest : path.join(process.env.HOME!, '.papercusp', 'pui-install.json'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const artifact = (raw: string) => path.resolve(path.dirname(manifestPath), raw);
    expect(realpathSync(artifact(manifest.binaryPath))).toBe(realpathSync(bin));
    expect(manifest.binarySha256).toBe(binarySha256);
    expect(createHash('sha256').update(readFileSync(artifact(manifest.companionPath))).digest('hex'))
      .toBe(manifest.companionSha256);
    return manifest;
}
/** A real engine's approval for the SU's own papercusp-su call (D-021). */
function isSuToolApprovalCard(card: { prompt: string }): boolean {
  return /^Allow mcp__papercusp-su__[\w-]+\?/.test(card.prompt);
}

function pendingNativeCards(events: SuSessionEvent[] = scriptedEngine.events) {
  const closed = new Set(events.flatMap((event) => event.type === 'card' && event.phase === 'closed' ? [event.correlationId] : []));
  return events.flatMap((event) => event.type === 'card' && event.phase === 'opened' && !closed.has(event.card.correlationId) ? [event.card] : []);
}

async function startOperatorProcess(port = 0) {
  const events: SuSessionEvent[] = [];
  const readiness: Array<Record<string, unknown>> = [];
  const shutdownStages: string[] = [];
  const descriptors = new Map<string, SuSessionDescriptor>();
  const diagnostics: Array<{ level: string; args: unknown[] }> = [];
  const responses: Array<{
    path: string;
    status: number;
    model?: string;
    account?: string;
    mode?: string;
    carry?: string;
    planSlug?: string;
  }> = [];
  let ready: { pid: number; instanceId: string; port: number } | undefined;
  let startupError: Error | undefined;
  let stopped = false;
  let shutdownFailure: string | undefined;
  let output = '';
  const child = fork(path.join(__dirname, 'operator-process.mts'), [], {
    cwd: REPO_ROOT, execArgv: ['--import', 'tsx'],
    env: { ...process.env, PUI_OPERATOR_FIXTURE_WORKSPACE: WORKSPACE, PUI_OPERATOR_FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', (error) => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => {
    output = (output + redactSensitiveText(bytes.toString())).slice(-32_000);
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.on('message', (message: { type: string; descriptor?: SuSessionDescriptor; event?: SuSessionEvent;
    events?: SuSessionEvent[]; pid: number; instanceId: string; port: number; level: string; args: unknown[];
    path: string; status: number; method?: string; requestedAt?: string; respondedAt?: string; error?: string;
    model?: string | null; account?: string | null; mode?: string | null; carry?: string | null;
    planSlug?: string | null;
    before?: unknown[]; after?: unknown[]; body?: unknown; stage?: string; workers?: unknown }) => {
    if (message.type === 'ready') ready = { pid: message.pid, instanceId: message.instanceId, port: message.port };
    if (['ready', 'shutdown-stage', 'stopped'].includes(message.type)) {
      console.info('PUI_OPERATOR_PROCESS_STAGE', JSON.stringify({ type: message.type, stage: message.stage,
        pid: message.pid, instanceId: message.instanceId, workers: message.workers, at: new Date().toISOString() }));
      if (message.stage) shutdownStages.push(message.stage);
    }
    if (message.descriptor) descriptors.set(message.descriptor.identity.agentChatId, message.descriptor);
    if (message.type === 'host') events.push(...message.events ?? []);
    if (message.type === 'event' && message.event) events.push(message.event);
    if (message.type === 'diagnostic') diagnostics.push({ level: message.level, args: message.args });
    if (message.type === 'stopped') stopped = true;
    if (message.type === 'shutdown-failed') shutdownFailure = message.error ?? 'unknown shutdown failure';
    if (message.type === 'response') responses.push({
      path: message.path,
      status: message.status,
      model: normalizeIpcOptionalLaunchField(message.model),
      account: normalizeIpcOptionalLaunchField(message.account),
      mode: normalizeIpcOptionalLaunchField(message.mode),
      carry: normalizeIpcOptionalLaunchField(message.carry),
      planSlug: normalizeIpcOptionalLaunchField(message.planSlug),
    });
    if (message.type === 'readiness') readiness.push({ path: message.path, method: message.method,
      requestedAt: message.requestedAt, respondedAt: message.respondedAt, status: message.status,
      before: message.before, after: message.after, body: message.body });
  });
  const stop = async ({ endSessions = true }: { endSessions?: boolean } = {}) => {
    if (child.connected) child.send({ type: endSessions ? 'stop' : 'restart' });
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([exit, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operator fixture did not exit: ${output}`)), 60_000);
      })]);
      console.info('PUI_OPERATOR_PROCESS_EXIT', JSON.stringify({ pid: child.pid, instanceId: ready?.instanceId, ...result }));
      expect(shutdownFailure, output).toBeUndefined();
      expect(stopped, output).toBe(true);
      expect(result, output).toEqual({ code: null, signal: 'SIGKILL' });
    } finally {
      clearTimeout(timer!);
      // SIGTERM is handled by this fixture and can be swallowed by an already
      // running shutdown. Escalate directly so a failed cleanup cannot survive
      // the parent-side timeout and wedge the enclosing test-file reaper.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  };
  try {
    await vi.waitFor(() => {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Operator fixture exited before ready: ${output}`);
      expect(ready, output).toBeDefined();
    }, { timeout: 120_000, interval: 100 });
  } catch (error) { await stop().catch(() => {}); throw error; }
  return { ...ready!, events, descriptors, diagnostics, responses, readiness, shutdownStages, stop, output: () => output };
}

function cleanupErrorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function preservePrimaryFailureDuringCleanup(
  primaryFailure: { error: unknown } | null,
  cleanups: ReadonlyArray<{ label: string; run: () => Promise<void> }>,
  report: (details: Record<string, unknown>) => void = (details) => {
    console.info('PUI_OPERATOR_PROCESS_CLEANUP_AFTER_PRIMARY_FAILURE', JSON.stringify(details));
  },
): Promise<void> {
  const cleanupFailures: Array<{ label: string; error: unknown }> = [];
  for (const cleanup of cleanups) {
    try { await cleanup.run(); }
    catch (error) { cleanupFailures.push({ label: cleanup.label, error }); }
  }
  if (cleanupFailures.length === 0) return;
  if (!primaryFailure) {
    if (cleanupFailures.length === 1) throw cleanupFailures[0].error;
    throw new AggregateError(cleanupFailures.map(({ error }) => error), 'PUI operator fixture cleanup failed');
  }
  report({
    primary: cleanupErrorText(primaryFailure.error),
    cleanupFailures: cleanupFailures.map(({ label, error }) => ({ label, error: cleanupErrorText(error) })),
  });
}

/**
 * P-007 conversation-editor spec clauses.
 *
 * Each case is written to its clause's own recorded falsifier rather than to a
 * convenient screen assertion, so a regression in the behavior genuinely fails
 * the case. These share the file's real harness above — installed `pui` binary,
 * real PTY, real Hono operator, real migrated Postgres — which is what makes
 * them e2e-layer evidence instead of a reducer test in disguise.
 */
describe.skipIf(scriptedEngine.real).sequential('PUI P-007 conversation editor (spec clauses)', () => {
  // PUI-EDITOR-COPY — "Copying a selected transcript result preserves its plain
  // text." Falsifier: "Copied text contains terminal escape sequences or omits
  // selected result content."
  //
  // Both halves are decided against the decoded OSC 52 payload — the bytes the
  // terminal would actually put on the clipboard. Asserting on the rendered
  // screen instead would be unfalsifiable for the escape-sequence half, since
  // the screen is escape-formatted by construction.
  test('PUI-EDITOR-COPY: copying a focused transcript result preserves its plain text', async () => {
    const prompt = 'PUI copy clause probe';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      // The scripted engine's Read tool result is the block under test; if it
      // never rendered, the copy assertion below would be vacuous.
      expect(pane.screen()).toContain('Read');

      // `y` is deliberately unreachable while composing (the composer's own
      // Char arm returns first), so the transcript copy contract only exists
      // once the composer is closed.
      pane.escape();
      await pane.waitFor('i type · v speak');

      // Walk focus back through the newest blocks with `{`, copying each block
      // in BOTH forms — `y` is the rendered block, `Shift-Y` its raw payload.
      //
      // Pressing only `y` cannot decide this clause. A tool call's RENDERED
      // form is deliberately the summary line `tool <name> → <outcome>`
      // (`chat_copy.rs::block_at`); the result body lives only in the raw
      // form, which is why the contract has two keys at all. A `y`-only probe
      // therefore reports "selected result content omitted" against an
      // implementation that is behaving exactly as contracted — a false red
      // this case is written to avoid.
      //
      // Walking rather than pinning one index keeps the probe faithful to the
      // behavior under test: the transcript may fold the tool into the
      // assistant turn or stand it up as its own block, and this clause is
      // about the copy, not about one block layout.
      const press = async (key: 'y' | 'Y'): Promise<string[]> => {
        const before = pane.clipboardWrites().length;
        pane.write(key);
        // Either an OSC 52 payload lands, or this block has no such form — a
        // plain user message has no raw payload, and `Shift-Y` must then
        // acknowledge rather than silently copy the rendered form. Both settle
        // well inside this window, so a press contributing no payload is the
        // `Unavailable` branch doing its job, not a failure.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return pane.clipboardWrites().slice(before);
      };
      const renderedCopies: string[] = [];
      const rawCopies: string[] = [];
      for (let step = 0; step < 4; step += 1) {
        // COPY FIRST, then step. `effective_chat_focus()` resolves an unset
        // focus to the NEWEST block, so the assistant turn — the only block
        // carrying the tool result this clause is about — is already focused
        // before any motion. Stepping first walks straight off it onto the
        // user message, and `step_chat_focus`'s saturating clamp at index 0
        // then pins focus there for every later iteration: a user message has
        // no raw payload, so every `Shift-Y` would land on `Unavailable` and
        // the probe would read "the raw form copies nothing" against a
        // perfectly healthy implementation.
        renderedCopies.push(...(await press('y')));
        rawCopies.push(...(await press('Y')));
        pane.write('{');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const copied = [...renderedCopies, ...rawCopies];
      expect(renderedCopies.length, pane.screen()).toBeGreaterThan(0);
      expect(rawCopies.length, pane.screen()).toBeGreaterThan(0);

      // Falsifier half 1 — the selected content must not be omitted, in either
      // form: the rendered copy carries the assistant's visible reply, and the
      // raw copy carries the tool result body itself.
      expect(renderedCopies.join('\n--- block ---\n')).toContain(scriptedEngine.successText);
      expect(rawCopies.join('\n--- block ---\n')).toContain('scripted engine tool result');

      // Falsifier half 2 — no terminal escape sequence may survive into the
      // clipboard. ESC (and the 8-bit CSI introducer) can never occur in the
      // plain text this clause promises.
      //
      // This is decided against the DECODED OSC 52 payload — the bytes the
      // terminal would actually put on the clipboard — because the rendered
      // screen cannot decide it: the screen is escape-formatted by
      // construction, so it cannot tell "the copy carries plain text" from
      // "the copy carries the escapes that drew it". It is genuinely
      // falsifiable rather than vacuous: the obvious wrong implementation of
      // this feature is to copy the focused block's screen region, and the
      // focus highlight guarantees such a payload arrives wrapped in SGR
      // codes, which these assertions catch.
      for (const payload of copied) {
        expect(payload).not.toMatch(/\x1b/);
        // ...and the 8-bit CSI introducer, U+009B. It appears here as a literal
        // character because this write path normalises a \u escape back into
        // one; the duplicate line below is the same assertion. If a formatter
        // ever strips these invisible literals, replace both with
        // `expect(payload).not.toContain(String.fromCharCode(0x9b))` rather
        // than deleting them — they are half of this clause's falsifier.
        expect(payload).not.toMatch(//);
        expect(payload).not.toMatch(//);
      }
      expect(copied.some((payload) => payload.trim().length > 0)).toBe(true);

      console.info(
        'PUI_EDITOR_COPY_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          copiedBlocks: copied.length,
          renderedBlocks: renderedCopies.length,
          rawBlocks: rawCopies.length,
          carriedSelectedResult: rawCopies.some((payload) => payload.includes('scripted engine tool result')),
          carriedRenderedReply: renderedCopies.some((payload) => payload.includes(scriptedEngine.successText)),
        }),
      );
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-EDITOR-UNDO — "Undo restores the pre-paste draft." Falsifier: "Undo
  // corrupts Unicode or loses the pre-paste draft."
  //
  // Undo did not exist when this clause was written: PUBLIC_RELEASE_UX.md:372
  // promises the composer supports "Unicode bracketed paste, undo/history, and
  // draft preservation", and only history and draft preservation had shipped.
  // A green suite could not reveal that, because absent code has no failing
  // test — which is exactly why the clause, not the suite, is the completeness
  // oracle here. `Ctrl-Z` + `App::chat_undo` were added with it.
  //
  // LAYERING, stated deliberately. The two falsifier halves are decided at the
  // layer that can actually decide them:
  //   * "corrupts Unicode" is a BYTE-EXACTNESS claim, and the rendered screen
  //     is a lossy oracle for it — a terminal may normalise a combining mark
  //     into one cell, and emoji cell-width varies by emulator, so a screen
  //     comparison could fail (or PASS) for reasons having nothing to do with
  //     undo. It is asserted against the model in the unit test
  //     `composer_undo_restores_the_pre_paste_draft_without_corrupting_unicode`,
  //     whose draft carries a combining acute, an astral emoji and RTL text.
  //   * THIS case decides the half only an e2e run can: that the whole path —
  //     real PTY bracketed paste, real key decoding, real composer — restores
  //     the draft at all. Its draft is multi-byte (Greek, umlaut, CJK) but
  //     render-stable, so a failure here means the PATH is broken, never that
  //     the terminal renders combining marks differently than expected.
  test('PUI-EDITOR-UNDO: undo restores the exact pre-paste draft', async () => {
    const draft = 'δraft ünsent 日本語';
    const pasted = 'PASTED-LINE-THAT-MUST-VANISH';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      // `openComposer` already leaves the pane IN compose mode — every sibling
      // case types its prompt directly after it and only presses Esc later to
      // LEAVE. An extra `i` here does not open the composer, it types a literal
      // "i" as the first character of the draft.
      await openComposer(pane);
      pane.write(draft);
      await pane.waitFor(`> ${draft}`);

      // A REAL bracketed paste, not replayed keystrokes. The clause is about
      // the paste path specifically: bracketed content is ONE edit the user
      // cannot walk back with Backspace, which is why undo exists for it.
      pane.write(`\x1b[200~${pasted}\x1b[201~`);
      await pane.waitFor(`> ${draft}${pasted}`);

      // Ctrl-Z is the byte 0x1a. The composer runs the terminal in raw mode, so
      // ISIG is off and this arrives as Char('z')+CONTROL rather than raising
      // SIGTSTP and suspending the process.
      pane.write('\x1a');

      // Falsifier half — the pre-paste draft must come back, and the pasted
      // text must be GONE. Asserting only the first would pass against an undo
      // that merely appended the draft again.
      // Wait for the pasted text to LEAVE, never for the draft to reappear: the
      // draft is a PREFIX of the un-undone line, so a positive wait is satisfied
      // by the very state undo is supposed to end and returns before the app has
      // processed the key at all. This waits on the falsifier condition itself,
      // so a genuinely broken undo times out here instead of racing through.
      await pane.waitForGone(pasted, { timeoutMs: 10_000 });
      const screen = pane.screen();
      // `screenContains`, not `toContain`: this draft's CJK glyphs each occupy
      // TWO terminal columns, so the captured grid carries a blank continuation
      // column between them (`日 本 語`) that a raw substring test cannot see
      // past. `pasted` is ASCII and unaffected, so it stays a raw assertion —
      // and it must stay one, being half of this clause's falsifier.
      expect(screenContains(screen, `> ${draft}`), screen).toBe(true);
      expect(screen, screen).not.toContain(pasted);

      // Undo must not submit: a turn dispatched here would send the very text
      // the owner just took back — the worst possible failure for this key.
      expect(screen).not.toContain('Sending — awaiting acceptance');
      expect(commandPosts).toHaveLength(0);

      console.info(
        'PUI_EDITOR_UNDO_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          draftRestored: screenContains(screen, `> ${draft}`),
          pastedTextGone: !screen.includes(pasted),
          submitted: commandPosts.length,
        }),
      );
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-EDITOR-HISTORY — Falsifier: "History navigation destroys the draft being
  // edited." Probe (the clause's own requiredEvidence): "Enter multiple prompts,
  // begin a new draft, navigate history and return to the saved draft."
  //
  // The behaviour under test ships and is deliberate: `App::chat_history_prev`
  // stashes `chat_input` into `chat_draft` on the FIRST Up (the `None` arm), and
  // `chat_history_next` restores it with `mem::take` when walking forward past
  // the newest entry. This case exercises that whole path through a real PTY.
  //
  // NON-VACUITY IS THE WHOLE DIFFICULTY HERE, in two separate ways.
  //
  //   1. An implementation where Up is simply INERT would "preserve the draft"
  //      perfectly and pass a naive draft-survives assertion. So this case must
  //      also prove history was genuinely REACHED — that the composer really did
  //      show the recalled prompts — or it proves nothing about navigation.
  //
  //   2. Asserting that with a bare `screen.toContain(promptB)` would be
  //      VACUOUSLY TRUE: both prompts were submitted, so they are already on
  //      screen in the TRANSCRIPT, forever, regardless of what the composer
  //      holds. That is a false GREEN, the opposite-direction sibling of the
  //      false RED the COPY case above documents. Every recall assertion here is
  //      therefore anchored to the COMPOSER LINE (`> ` + text), which is the only
  //      place that distinguishes "recalled into the composer" from "scrolled by
  //      in the transcript".
  //
  // The draft is deliberately ASCII. Byte-exactness under combining marks and
  // astral emoji belongs to PUI-EDITOR-UNDO (and its Rust unit complement); this
  // clause is about the draft SURVIVING, so a render-stable draft keeps a failure
  // here meaning "history navigation lost the draft" and never "this terminal
  // renders wide glyphs differently than expected".
  test('PUI-EDITOR-HISTORY: navigating history preserves and restores the in-progress draft', async () => {
    // Neither prompt is a substring of the other, so a composer-line assertion
    // for one can never be satisfied by the other.
    const promptA = 'PUI history clause alpha probe';
    const promptB = 'PUI history clause bravo probe';
    const draft = 'DRAFT-THAT-MUST-SURVIVE-HISTORY';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);

      // "Enter multiple prompts" — two, so that stepping back twice proves the
      // ring walks rather than pinning one entry.
      //
      // EACH TURN GETS ITS OWN REPLY TEXT, and that is load-bearing, not tidiness.
      // Waiting on a FIXED `successText` for the second turn is VACUOUS: the first
      // turn's reply is still in the transcript, so the wait returns instantly
      // without the second turn having been dispatched at all, and the test then
      // races ahead to assert against a composer that never accepted it. That is
      // the same transcript-vacuity trap this case guards against in its recall
      // assertions below — it just bites one scope earlier, in the SETUP. Giving
      // each turn a distinct reply makes the wait provably about THIS turn.
      // (Measured: with a shared successText this failed `toHaveLength(2) but got
      // 1` — the second Enter arrived while the first turn still owned the
      // composer, which refuses input until the turn completes.)
      const turns = [
        { prompt: promptA, reply: 'PUI history alpha turn completed' },
        { prompt: promptB, reply: 'PUI history bravo turn completed' },
      ];
      for (const [index, { prompt, reply }] of turns.entries()) {
        scriptedEngine.successText = reply;
        pane.write(prompt);
        pane.enter();
        await pane.waitFor(reply, { timeoutMs: 60_000 });
        await pane.waitFor('Message — Enter send');
        // Assert per ITERATION, not once at the end: a dispatch that silently
        // never happened is then attributed to the turn that dropped it.
        expect(commandPosts, pane.screen()).toHaveLength(index + 1);
      }
      // Both prompts genuinely reached the engine, in order — the precondition
      // for anything below to be a statement about history at all.
      expect(scriptedEngine.requests, pane.screen()).toEqual([promptA, promptB]);

      // "Begin a new draft" — typed, never submitted. This is the text the
      // clause says history navigation must not destroy.
      pane.write(draft);
      await pane.waitFor(`> ${draft}`);

      // Up (ANSI CUU). The composer runs the terminal in raw mode and crossterm
      // decodes this as KeyCode::Up, which `App` routes to `chat_history_prev`.
      pane.write('\x1b[A');
      // Recall half, step 1: the NEWEST entry must land on the composer line...
      await pane.waitFor(`> ${promptB}`, { timeoutMs: 10_000 });
      // ...and the draft must have LEFT the composer (it is stashed, not shown).
      // Waiting on the disappearance rather than asserting it after a positive
      // wait keeps this from racing; the draft is ASCII and appears nowhere else
      // on screen, so its absence is unambiguous.
      await pane.waitForGone(draft, { timeoutMs: 10_000 });

      // Step 2: the OLDER entry, proving the ring actually walks.
      pane.write('\x1b[A');
      await pane.waitFor(`> ${promptA}`, { timeoutMs: 10_000 });

      // Walk forward again: newest entry, then past it.
      pane.write('\x1b[B');
      await pane.waitFor(`> ${promptB}`, { timeoutMs: 10_000 });

      // THE CLAUSE'S CENTRAL ASSERTION — walking forward past the newest entry
      // must give the stashed draft back rather than clearing the line. A
      // positive wait is sound here (unlike the undo case): the draft is not a
      // prefix of the prompt currently displayed, so this cannot be satisfied by
      // the pre-restore state.
      pane.write('\x1b[B');
      await pane.waitFor(`> ${draft}`, { timeoutMs: 10_000 });

      const screen = pane.screen();
      // Restored EXACTLY: not truncated, and not concatenated onto a recalled
      // entry (the plausible wrong implementation appends instead of replacing).
      expect(screen, screen).toContain(`> ${draft}`);
      expect(screen, screen).not.toContain(`> ${promptB}${draft}`);
      expect(screen, screen).not.toContain(`> ${draft}${promptB}`);

      // History navigation must never dispatch a turn: recalling a previous
      // prompt and silently re-sending it is the worst failure these keys have.
      expect(commandPosts, screen).toHaveLength(2);
      expect(screen, screen).not.toContain('Sending — awaiting acceptance');

      console.info(
        'PUI_EDITOR_HISTORY_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          draftRestored: screen.includes(`> ${draft}`),
          recalledNewest: true,
          recalledOlder: true,
          submittedDuringNavigation: commandPosts.length - 2,
        }),
      );
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-FILE-CONTEXT — the selected project-scoped stable reference reaches
  // the next accepted prompt. Its authorization falsifier has two halves:
  // an explicit same-basename path OUTSIDE the project must be refused, and
  // the whole flow must remain usable through the real PTY (no native UI).
  test('PUI-FILE-CONTEXT: selecting a project file attaches only its stable reference to the next accepted prompt', async () => {
    const draft = 'PUI file context clause probe';
    const relativePath = 'AGENTS.md';
    const stableReference = `@${relativePath}`;
    const projectBytes = readFileSync(path.join(REPO_ROOT, relativePath));
    const outsideDir = path.join(home, 'other-project');
    const outsidePath = path.join(outsideDir, relativePath);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsidePath, 'same basename, wrong project');
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(draft);

      // Name a real same-basename file outside the active project. It is not
      // in the bounded listing, so Enter exercises the explicit-path refusal
      // path rather than a selected in-project row.
      pane.write('@');
      await pane.waitFor('Attach a file');
      pane.write(outsidePath);
      pane.enter();
      await pane.waitFor('outside this project');
      expect(pane.screen()).not.toContain(`Attached ${outsidePath}`);
      expect(scriptedEngine.requests).toHaveLength(0);

      // Re-open cleanly and choose the active project's namesake.
      pane.escape();
      pane.write('@');
      await pane.waitFor('Attach a file');
      pane.write(relativePath);
      await pane.waitFor(relativePath);
      pane.enter();
      await pane.waitFor(`Attached ${relativePath} · text · ${stableReference}`);

      // Enter toggles the attachment OFF without touching the file, then ON
      // again for the send. The byte comparison makes the safety claim about
      // the file itself rather than about the transient list state.
      pane.enter();
      await pane.waitFor(`Removed ${relativePath}`);
      expect(readFileSync(path.join(REPO_ROOT, relativePath))).toEqual(projectBytes);
      pane.enter();
      await pane.waitFor(`Attached ${relativePath} · text · ${stableReference}`);

      pane.escape();
      await pane.waitFor(`${relativePath} · text · ${stableReference}`);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      const accepted = `${draft}\n${stableReference}`;
      await vi.waitFor(() => expect(scriptedEngine.requests).toEqual([accepted]), {
        timeout: 30_000,
        interval: 100,
      });
      const saved = await waitForSavedTurn(accepted);
      expect(saved.transcript.some((turn) => turn.role === 'user' && turn.content === accepted)).toBe(true);
      expect(scriptedEngine.requests[0]).not.toContain(outsidePath);

      console.info(
        'PUI_FILE_CONTEXT_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          project: REPO_ROOT,
          selected: relativePath,
          stableReference,
          refusedOutsideProject: true,
          acceptedTurn: accepted,
        }),
      );
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-QUESTION — an inline native question is asked, answered and delivered
  // back inside the PUI. Falsifier: "answer lost/misattributed/needs the native
  // interface." Each of those three is decided separately below, because they
  // fail independently and a test that only proves one reads as proving all.
  //
  // The question is driven through the engine's real SDK permission callback,
  // so the card under test is minted by the production `SuNativeCards` path
  // that the live provider uses — not by fixture code standing in for it.
  test('PUI-QUESTION: an inline question is answered in the PUI and the answer reaches the asking turn', async () => {
    const prompt = 'PUI question clause probe';
    // Distinct from the default so the completion wait cannot be satisfied by
    // some earlier turn's text sitting in the append-only transcript.
    scriptedEngine.successText = 'PUI question clause answered';
    scriptedEngine.mode = 'question';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();

      // The card must OPEN and stay open: the turn parks until answered.
      await vi.waitFor(() => expect(pendingNativeCards()).toHaveLength(1), { timeout: 60_000, interval: 100 });
      const card = pendingNativeCards()[0];

      // Falsifier half 1 — "needs the native interface". The question and every
      // choice have to be legible in the PUI itself, and answerable from it.
      // Asserting only on the card OBJECT would not decide this: the card can be
      // perfectly well-formed in memory and never reach the terminal.
      await pane.waitFor(scriptedEngine.questionPrompt, { timeoutMs: 30_000 });
      for (const label of scriptedEngine.questionOptions) await pane.waitFor(label, { timeoutMs: 30_000 });
      const questionFrame = pane.screen();

      if (card.presentation?.kind !== 'radio' || !card.presentation.options) {
        throw new Error(`multiSelect:false must present a radio card, got ${JSON.stringify(card.presentation)}`);
      }
      expect(card.prompt).toBe(scriptedEngine.questionPrompt);
      // handleClaude appends its own free-text escape hatch, so the card carries
      // one more option than the model offered. Pinning an exact length here
      // would be asserting that detail rather than this clause.
      expect(card.presentation.options.map((option) => option.label)).toEqual(
        expect.arrayContaining(scriptedEngine.questionOptions),
      );

      // Still parked — nothing may have closed this card before the owner acted.
      expect(
        scriptedEngine.events.some(
          (event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === card.correlationId,
        ),
      ).toBe(false);
      expect(scriptedEngine.questionVerdicts).toHaveLength(0);

      // Answer it from the PUI, by keystroke — the same way an owner would.
      const choiceIndex = card.presentation.options.findIndex((option) => option.label === 'Change');
      expect(choiceIndex, questionFrame).toBeGreaterThanOrEqual(0);
      pane.write(String(choiceIndex + 1));
      await vi.waitFor(() => expect(cardReplies).toHaveLength(1), { timeout: 30_000, interval: 100 });
      expect(cardReplies[0]).toMatchObject({ status: 200 });

      // Falsifier half 2 — "answer lost". The selection has to arrive back at
      // the model, not merely close the card. The verdict below is what the
      // engine actually handed the provider.
      await vi.waitFor(() => expect(scriptedEngine.questionVerdicts).toHaveLength(1), {
        timeout: 30_000,
        interval: 100,
      });
      const verdict = scriptedEngine.questionVerdicts[0];
      expect(verdict.behavior, JSON.stringify(verdict)).toBe('allow');
      // Keyed by the exact question text: this is simultaneously the
      // "not lost" and the "not misattributed to another question" evidence.
      expect(verdict.updatedInput?.answers).toEqual({ [scriptedEngine.questionPrompt]: 'Change' });

      // Falsifier half 3 — "misattributed". The card has to belong to the turn
      // that asked. correlationId is minted by registerCard and is NOT the tool
      // call id, so attribution is carried by turnId, which must agree across
      // the asking tool event and both card phases.
      const opened = scriptedEngine.events.find(
        (event) => event.type === 'card' && event.phase === 'opened' && event.card.correlationId === card.correlationId,
      );
      const closed = scriptedEngine.events.find(
        (event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === card.correlationId,
      );
      const askedBy = scriptedEngine.events.find(
        (event) => event.type === 'tool' && event.phase === 'started' && event.name === 'AskUserQuestion',
      );
      if (opened?.type !== 'card' || closed?.type !== 'card' || askedBy?.type !== 'tool') {
        throw new Error('The question did not produce a matched tool/card open/close triple');
      }
      expect(closed).toMatchObject({ resolution: 'submitted' });
      expect(opened.turnId).toBe(askedBy.turnId);
      expect(closed.turnId).toBe(askedBy.turnId);
      // Exactly one card: a second one would mean the answer could have been
      // applied to the wrong prompt.
      expect(scriptedEngine.events.filter((event) => event.type === 'card' && event.phase === 'opened')).toHaveLength(
        1,
      );

      // The parked turn resumes only after the answer, and finishes in the PUI.
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect(scriptedEngine.requests).toEqual([prompt]);

      console.info(
        'PUI_QUESTION_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          prompt: card.prompt,
          options: card.presentation.options.map((option) => option.label),
          selected: 'Change',
          answers: verdict.updatedInput?.answers,
          turnId: opened.turnId,
          correlationId: card.correlationId,
          cardReplies,
        }),
      );
    } catch (error) {
      console.info(
        'PUI_QUESTION_FAILURE',
        JSON.stringify({
          ...pane.failureEvidence(),
          cardReplies,
          verdicts: scriptedEngine.questionVerdicts,
          cardEvents: scriptedEngine.events.filter((event) => event.type === 'card'),
        }),
      );
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-TOOLS-DIFF — a file edit is reviewable as a diff inside the PUI.
  // Falsifier: "reviewing the edit needs a native client, or the diff is
  // unavailable."
  //
  // The two halves are decided against DIFFERENT evidence on purpose. "No
  // native client" is a claim about the terminal, so it is decided on the
  // rendered screen. "The diff is available" is a claim about diff STRUCTURE
  // (hunk header, +/- gutter markers, both sides of the change), and the screen
  // cannot decide that: it wraps and pads, so an assertion on exact diff text
  // there would be brittle in the one direction that matters. The card's own
  // copy payload is the exact bytes `render()` produced, so the structure is
  // decided there — the same split the COPY clause makes.
  test('PUI-TOOLS-DIFF: a file edit opens a reviewable in-PUI diff', async () => {
    const prompt = 'PUI tools diff clause probe';
    scriptedEngine.successText = 'PUI diff clause replied';
    scriptedEngine.mode = 'edit';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');

      // Non-vacuity: the diff must not already be on screen. Without this, a
      // transcript that happened to print the tool arguments inline would
      // satisfy every assertion below while the card never opened at all.
      expect(pane.screen()).not.toContain('@@ hunk');

      pane.escape();
      await pane.waitFor('i type · v speak');

      // `Enter` opens the focused block's change card, but ONLY when the reader
      // has EXPLICITLY moved the cursor (app.rs::open_focused_change_card gates
      // on the RAW `chat_focus`, never the resolved one) — so a motion key is
      // required first, and `}` sets the cursor on the newest block without
      // moving off it (step_chat_focus clamps at the last index).
      //
      // Which block carries the edit is deliberately not pinned: the transcript
      // may fold the tool into the assistant turn or stand it up as its own
      // block, and this clause is about the diff, not about one block layout.
      // So walk older until the card opens. When `Enter` finds no card it falls
      // through to its other meaning and opens the COMPOSER, which is why each
      // miss is closed again before stepping.
      pane.write('}');
      let opened = false;
      for (let step = 0; step < 6 && !opened; step += 1) {
        pane.enter();
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (pane.screen().includes('@@ hunk')) {
          opened = true;
          break;
        }
        if (pane.screen().includes('Message — Enter send')) {
          pane.escape();
          await pane.waitFor('i type · v speak');
        }
        pane.write('{');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const diffFrame = pane.screen();
      expect(opened, diffFrame).toBe(true);

      // Falsifier half 1 — "needs a native client". The review surface has to be
      // the terminal itself: the file under edit and BOTH sides of the change
      // are legible here, with no other client involved.
      expect(diffFrame).toContain(scriptedEngine.editPath);
      expect(diffFrame).toContain('dropped');
      expect(diffFrame).toContain('introduced');

      // Falsifier half 2 — "the diff is unavailable". Decided on the card's own
      // copy payload, which is exactly what the scroll view painted
      // (change_card.rs: render_lines feeds both), so screen and clipboard
      // cannot disagree about what was reviewed.
      const before = pane.clipboardWrites().length;
      pane.write('y');
      await vi.waitFor(() => expect(pane.clipboardWrites().length).toBeGreaterThan(before), {
        timeout: 15_000,
        interval: 100,
      });
      const payload = pane.clipboardWrites().slice(before).join('\n');

      // Title states the file and the shape of the change.
      expect(payload).toContain(`Edit · ${scriptedEngine.editPath} · +1 -1`);
      // Hunk context, and the classic ASCII gutter trio — a card must read as a
      // diff to a human AND to a tool, so the markers are load-bearing, not
      // decoration. Asserting only that the words appear would pass against a
      // card that printed the new file with no diff structure at all.
      expect(payload).toContain('@@ hunk 1/1 @@');
      expect(payload).toContain('-    let dropped = 2;');
      expect(payload).toContain('+    let introduced = 3;');
      // The unchanged line is carried as CONTEXT (leading space), which is what
      // makes the hunk reviewable rather than a bare pair of edits.
      expect(payload).toContain('     let kept = 1;');

      console.info(
        'PUI_TOOLS_DIFF_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          path: scriptedEngine.editPath,
          payload,
        }),
      );
    } catch (error) {
      console.info(
        'PUI_TOOLS_DIFF_FAILURE',
        JSON.stringify({ ...pane.failureEvidence(), clipboard: pane.clipboardWrites() }),
      );
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // AUTO-BAR-R-05-P-007 — editing a draft while a turn streams must disturb
  // neither side. Falsifier: "streaming drops/reorders/sends text from the new
  // draft." Probe (from the spec): paste and edit a Unicode multiline draft
  // DURING a streamed turn, then inspect the submitted bytes.
  //
  // Three independent failures, so three independent checks:
  //   dropped/reordered -> the exact chunk concatenation must appear;
  //   sent -> no additional turn may be dispatched while the draft sits;
  //   corrupted -> the bytes finally submitted must equal the draft exactly.
  test('AUTO-BAR-R-05-P-007: editing a draft during a streamed turn neither disturbs the stream nor sends the draft', async () => {
    const prompt = 'AUTO-BAR stream clause probe';
    // Multiline AND non-ASCII: the clause names both, and a pure-ASCII draft
    // would leave the Unicode half of "corrupted" untested.
    const draft = 'héllo — ünïcode ✓\nseconde ligne\n第三行';
    scriptedEngine.mode = 'stream';
    const streamed = scriptedEngine.streamChunks.join('');
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();

      // Wait for the FIRST chunk only: that proves the turn is genuinely
      // mid-stream, so the editing below happens during streaming rather than
      // after it — which is the entire premise of this clause.
      await pane.waitFor(scriptedEngine.streamChunks[0], { timeoutMs: 60_000 });
      expect(pane.screen(), pane.screen()).not.toContain(streamed);
      const postsBeforeDraft = commandPosts.length;

      // A REAL bracketed paste — one edit, exactly as a user pasting multiline
      // Unicode would produce. Replayed keystrokes would take a different code
      // path and would not exercise the paste handling the clause names.
      //
      // The composer is ALREADY open here: `openComposer` is a first-open
      // helper (it waits for `session new`), so calling it again would block
      // until it timed out — and the stream would finish while it waited,
      // quietly turning this into an after-the-turn test instead of the
      // during-the-turn one the clause requires.
      await pane.waitFor('Message — Enter send');
      pane.write(`\x1b[200~${draft}\x1b[201~`);
      // Then EDIT it, as the spec's probe says: append after the paste.
      const appended = ' ⟵ edited';
      pane.write(appended);
      // The draft has to be IN the composer for the rest of this to mean
      // anything; anchor to the composer line (`> `), never a bare screen
      // match.
      await pane.waitFor(`> ${draft.split('\n')[0]}`, { timeoutMs: 20_000 });

      // Falsifier half 1 — the stream must not be dropped or reordered by the
      // editing. Asserting the exact concatenation decides both at once: a drop
      // breaks the string, and so does a swap.
      await pane.waitFor(streamed, { timeoutMs: 60_000 });

      // Falsifier half 2 — "sends text from the new draft". Nothing the user
      // typed may be dispatched as a turn while it is still a draft, and the
      // streamed turn completing must not sweep it up either.
      expect(commandPosts.length, pane.screen()).toBe(postsBeforeDraft);
      expect(scriptedEngine.requests, pane.screen()).toEqual([prompt]);

      // Falsifier half 3 — the bytes. Submit the draft only now, and require
      // the engine to have received it EXACTLY: same Unicode, same newlines,
      // same order. This is the "inspect submitted bytes" the probe asks for,
      // and it is decided against what the engine received rather than against
      // the screen, which cannot show trailing or duplicated whitespace.
      pane.enter();
      await vi.waitFor(() => expect(scriptedEngine.requests).toHaveLength(2), { timeout: 60_000, interval: 100 });
      expect(scriptedEngine.requests[1]).toBe(`${draft}${appended}`);

      console.info(
        'AUTO_BAR_R_05_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          streamed,
          submitted: scriptedEngine.requests[1],
          draftIntact: scriptedEngine.requests[1] === `${draft}${appended}`,
          turnsDispatched: scriptedEngine.requests.length,
        }),
      );
    } catch (error) {
      console.info(
        'AUTO_BAR_R_05_FAILURE',
        JSON.stringify({
          ...pane.failureEvidence(),
          requests: scriptedEngine.requests,
          commandPosts: commandPosts.length,
        }),
      );
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // Shared setup for the two approval clauses: raise BOTH requests, then work
  // out which one the PUI has actually focused rather than assuming an order.
  //
  // The PUI focuses `cards.first()` (card_view.rs::focused_correlation_id) and
  // offers no card-to-card navigation, so exactly one request is answerable at
  // a time. Which one that is comes from the SCREEN — the approval prompt
  // embeds the tool input verbatim — because pinning it to the order the
  // fixture fired them in would be asserting the fixture, not the PUI, and
  // would silently answer the wrong request if that order ever changed.
  const raiseTwoApprovals = async (pane: PuiPane, prompt: string) => {
    await openComposer(pane);
    pane.write(prompt);
    pane.enter();
    await vi.waitFor(() => expect(pendingNativeCards()).toHaveLength(2), { timeout: 60_000, interval: 100 });
    const focusedTag = await vi.waitFor(
      () => {
        const screen = pane.screen();
        const shown = scriptedEngine.approvalRequests.filter((r) => screen.includes(String(r.input.command)));
        // Exactly one focused request must be legible, or "which one did the
        // owner authorise" is not a well-posed question and the assertions below
        // would be deciding nothing.
        expect(shown, screen).toHaveLength(1);
        return shown[0].tag;
      },
      { timeout: 30_000, interval: 200 },
    );
    const peer = scriptedEngine.approvalRequests.find((r) => r.tag !== focusedTag);
    if (!peer) throw new Error('The approval fixture must raise two distinct requests');
    const focused = scriptedEngine.approvalRequests.find((r) => r.tag === focusedTag);
    if (!focused) throw new Error(`No approval request tagged ${focusedTag}`);
    // Options are exactly Approve(1)/Decline(2): the non-question branch passes
    // that pair with no free-text escape hatch appended.
    await pane.waitFor('Approve');
    await pane.waitFor('Decline');
    expect(scriptedEngine.approvalVerdicts).toHaveLength(0);
    return { focused, peer };
  };

  // PUI-APPROVAL-ALLOW — approving one request authorises exactly that action.
  // Falsifier: "allow executes a broader action or hits an unrelated session."
  // Probe (the clause's own): two isolated requests, approve one, check exact
  // execution + peer still pending.
  test('PUI-APPROVAL-ALLOW / AUTO-BAR-R-09-P-010: approving one request executes exactly it and leaves its peer pending', async () => {
    scriptedEngine.successText = 'PUI approval clause replied';
    scriptedEngine.mode = 'approval';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      const { focused, peer } = await raiseTwoApprovals(pane, 'PUI approval allow clause probe');
      expect(scriptedEngine.sdkPermissions).toEqual([{ mode: 'default', bypass: undefined }]);
      expect(launchRequests[0]).toMatchObject({ account: 'default' });
      expect((launchRequests[0] as { mode?: unknown }).mode ?? null).toBeNull();
      const peerCard = pendingNativeCards().find((card) => card.prompt.includes(String(peer.input.command)));
      expect(peerCard, pane.screen()).toBeDefined();

      pane.write('1'); // Approve
      await vi.waitFor(() => expect(cardReplies).toHaveLength(1), { timeout: 30_000, interval: 100 });
      expect(cardReplies[0]).toMatchObject({ status: 200 });
      await vi.waitFor(() => expect(scriptedEngine.approvalVerdicts).toHaveLength(1), {
        timeout: 30_000,
        interval: 100,
      });

      // Falsifier half 1 — EXACT execution. The authorised call must be the one
      // that was shown, carrying the arguments that were shown: not a widened
      // command, not a different tool input.
      const settled = scriptedEngine.approvalVerdicts[0];
      expect(settled.tag).toBe(focused.tag);
      expect(settled.verdict.behavior, JSON.stringify(settled)).toBe('allow');
      expect(settled.verdict.updatedInput).toEqual(focused.input);
      expect(scriptedEngine.approvalExecuted).toEqual([{ tag: focused.tag, input: focused.input }]);

      // Falsifier half 2 — the peer is UNTOUCHED. One authorisation must not
      // travel to another request: no verdict, nothing executed, card still
      // open. All three, because each fails differently.
      expect(scriptedEngine.approvalVerdicts.map((v) => v.tag)).not.toContain(peer.tag);
      expect(scriptedEngine.approvalExecuted.map((e) => e.tag)).not.toContain(peer.tag);
      expect(
        scriptedEngine.events.some(
          (event) =>
            event.type === 'card' && event.phase === 'closed' && event.correlationId === peerCard?.correlationId,
        ),
      ).toBe(false);
      expect(pendingNativeCards().map((card) => card.correlationId)).toContain(peerCard?.correlationId);

      console.info(
        'PUI_APPROVAL_ALLOW_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          approved: focused.tag,
          executed: scriptedEngine.approvalExecuted,
          peerStillPending: true,
          peerCorrelationId: peerCard?.correlationId,
        }),
      );

      // Settle the peer so the turn can finish rather than being torn down
      // mid-flight, which would leave the engine cancelling a live card.
      pane.write('2');
      await vi.waitFor(() => expect(scriptedEngine.approvalVerdicts).toHaveLength(2), {
        timeout: 30_000,
        interval: 100,
      });
    } catch (error) {
      console.info(
        'PUI_APPROVAL_ALLOW_FAILURE',
        JSON.stringify({
          ...pane.failureEvidence(),
          verdicts: scriptedEngine.approvalVerdicts,
          executed: scriptedEngine.approvalExecuted,
          cardReplies,
        }),
      );
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // PUI-APPROVAL-DENY — declining a request stops exactly that action.
  // Falsifier: "denied action executes or affects a different request."
  test('PUI-APPROVAL-DENY / AUTO-BAR-R-09-P-010: declining one request executes nothing and leaves its peer pending', async () => {
    scriptedEngine.successText = 'PUI approval deny clause replied';
    scriptedEngine.mode = 'approval';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      const { focused, peer } = await raiseTwoApprovals(pane, 'PUI approval deny clause probe');
      expect(scriptedEngine.sdkPermissions).toEqual([{ mode: 'default', bypass: undefined }]);
      expect(launchRequests[0]).toMatchObject({ account: 'default' });
      expect((launchRequests[0] as { mode?: unknown }).mode ?? null).toBeNull();
      const peerCard = pendingNativeCards().find((card) => card.prompt.includes(String(peer.input.command)));
      expect(peerCard, pane.screen()).toBeDefined();

      pane.write('2'); // Decline
      await vi.waitFor(() => expect(cardReplies).toHaveLength(1), { timeout: 30_000, interval: 100 });
      expect(cardReplies[0]).toMatchObject({ status: 200 });
      await vi.waitFor(() => expect(scriptedEngine.approvalVerdicts).toHaveLength(1), {
        timeout: 30_000,
        interval: 100,
      });

      // Falsifier half 1 — "the denied action executes". The verdict must
      // refuse, and nothing may have run: the executed list is what the fixture
      // appends ONLY on an authorising verdict, so an empty list here is the
      // direct observation that no call was authorised.
      const settled = scriptedEngine.approvalVerdicts[0];
      expect(settled.tag).toBe(focused.tag);
      expect(settled.verdict.behavior, JSON.stringify(settled)).toBe('deny');
      expect(scriptedEngine.approvalExecuted).toEqual([]);

      // Falsifier half 2 — "affects a different request". A denial must not
      // cascade: the peer keeps its own undecided state.
      expect(scriptedEngine.approvalVerdicts.map((v) => v.tag)).not.toContain(peer.tag);
      expect(
        scriptedEngine.events.some(
          (event) =>
            event.type === 'card' && event.phase === 'closed' && event.correlationId === peerCard?.correlationId,
        ),
      ).toBe(false);
      expect(pendingNativeCards().map((card) => card.correlationId)).toContain(peerCard?.correlationId);

      console.info(
        'PUI_APPROVAL_DENY_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          declined: focused.tag,
          executed: scriptedEngine.approvalExecuted,
          peerStillPending: true,
          peerCorrelationId: peerCard?.correlationId,
        }),
      );

      // Now APPROVE the peer. This is the sharpest evidence the two requests are
      // genuinely independent: the same pair of cards yields opposite outcomes,
      // so neither verdict can have been a property of the batch.
      pane.write('1');
      await vi.waitFor(() => expect(scriptedEngine.approvalVerdicts).toHaveLength(2), {
        timeout: 30_000,
        interval: 100,
      });
      expect(scriptedEngine.approvalExecuted).toEqual([{ tag: peer.tag, input: peer.input }]);
    } catch (error) {
      console.info(
        'PUI_APPROVAL_DENY_FAILURE',
        JSON.stringify({
          ...pane.failureEvidence(),
          verdicts: scriptedEngine.approvalVerdicts,
          executed: scriptedEngine.approvalExecuted,
          cardReplies,
        }),
      );
      throw error;
    } finally {
      await pane.stop().catch(() => {});
    }
  });
});

describe.skipIf(scriptedEngine.real).sequential('PUI P-013 terminal compatibility and responsiveness', () => {
  // Targets are the plan's Acceptance section (pui-first-party-public-release):
  // local key feedback p95 <= 100 ms, local send acceptance/busy feedback
  // <= 250 ms, an initialized application's usable first frame <= 2 s; 80x24,
  // 120x40 and 200x60 with a resize during streaming; light, dark,
  // high-contrast and colour-disabled modes; the 80x20 floor from
  // PUBLIC_RELEASE_UX.md. Latency runs from the PTY write to the chunk that
  // makes the change visible on an incremental VT, so the harness's own
  // polling can never inflate a sample.
  const KEY_FEEDBACK_P95_MS = 100;
  const SEND_FEEDBACK_MS = 250;
  const FIRST_FRAME_MS = 2_000;
  // The budgets describe the product: an optimised build on the declared test
  // machine (release acceptance runs this block on the installed candidate). A
  // debug build still takes and reports every measurement, unasserted.
  const optimised = () => !bin.includes(`${path.sep}debug${path.sep}`);

  function p95(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }

  /** Milliseconds from `act()` until the rendered screen satisfies `ready`. */
  function renderedAfter(
    pane: PuiPane,
    act: () => void,
    ready: (screen: string) => boolean,
    timeoutMs = 5_000,
  ): Promise<number> {
    const vt = new VtScreen(pane.size.rows, pane.size.cols);
    vt.feed(pane.rawSince(0));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error(`not rendered within ${timeoutMs}ms:\n${vt.text()}`));
      }, timeoutMs);
      const subscription = pane.pty.onData((chunk) => {
        vt.feed(chunk);
        if (!ready(vt.text())) return;
        clearTimeout(timer);
        subscription.dispose();
        resolve(performance.now() - started);
      });
      const started = performance.now();
      act();
    });
  }

  /** Per-key feedback samples: each key's time until the draft shows it. */
  async function keyFeedback(pane: PuiPane, keys: string): Promise<number[]> {
    const base = `K${randomUUID().slice(0, 6)} `;
    pane.write(base);
    await pane.waitFor(base.trim());
    let draft = base;
    const samples: number[] = [];
    for (const key of keys) {
      draft += key;
      const expected = draft;
      samples.push(await renderedAfter(pane, () => pane.write(key), (screen) => screen.includes(expected)));
    }
    return samples;
  }

  /** Every SGR parameter list (`ESC [ … m`) in a raw PTY stream. */
  function sgrParams(raw: string): string[] {
    return [...raw.matchAll(/\u001b\[([0-9;:]*)m/g)].map((match) => match[1]);
  }

  /** Whether an SGR list sets a colour: basic/bright fg or bg, or an extended
   *  38/48/58 (256-colour or RGB). 39/49/59 restore the terminal default and
   *  0–29 are attributes, so neither counts. */
  function setsColour(params: string): boolean {
    return params.split(/[;:]/).map(Number).some((n) =>
      (n >= 30 && n <= 38) || (n >= 40 && n <= 48) || n === 58 || (n >= 90 && n <= 97) || (n >= 100 && n <= 107));
  }

  /** The PUI process's resident set, in MiB. */
  function rssMiB(pane: PuiPane): number {
    const status = readFileSync(`/proc/${pane.pty.pid}/status`, 'utf8');
    return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1]) / 1024;
  }

  test('P-013: NO_COLOR draws no colour and still marks the selection', { timeout: 120_000 }, async () => {
    // Calibration: by default the same screen IS coloured, so a parser that
    // never recognised colour could not pass the colour-disabled half.
    const coloured = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      await openAgentChat(coloured);
      expect(sgrParams(coloured.rawSince(0)).some(setsColour)).toBe(true);
    } finally {
      await coloured.stop().catch(() => {});
    }
    const plain = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40, env: { NO_COLOR: '1' } });
    try {
      await openAgentChat(plain);
      const params = sgrParams(plain.rawSince(0));
      expect(params.filter(setsColour)).toEqual([]);
      // The selected tab carried its meaning only by its fill; without colour
      // it is still marked, as reverse video (SGR 7).
      expect(params.some((list) => list.split(/[;:]/).includes('7'))).toBe(true);
      console.info('PUI_P013_COLOR_DISABLED_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, sgrLists: params.length, frame: plain.screen(),
      }));
    } finally {
      await plain.stop().catch(() => {});
    }
  });

  test('P-013: below 80x20 a blocking view holds the draft and a resize back resumes it', { timeout: 120_000 }, async () => {
    const draft = `P13 small ${randomUUID().slice(0, 8)}`;
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      await openComposer(pane, false);
      pane.write(draft);
      await pane.waitFor(draft);
      pane.resize(70, 18);
      await pane.waitFor('Terminal too small');
      await pane.waitFor('resize to at least 80×20');
      expect(pane.screen()).not.toContain(draft);
      pane.write('zzz'); // held: nothing the owner cannot see changes
      // The keys (PTY bytes) and the resize (SIGWINCH) reach the PUI on separate
      // channels, so their processing order is not fixed. Let the event loop consume
      // the held keys at the small size first; otherwise a slow debug build under load
      // applies the resize first and then correctly accepts 'zzz' at 80x24.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      pane.resize(80, 24);
      await pane.waitFor(draft);
      await pane.waitForGone('Terminal too small');
      expect(pane.screen()).not.toContain(`${draft}zzz`);
      pane.write('!');
      await pane.waitFor(`${draft}!`);
      console.info('PUI_P013_TOO_SMALL_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, frame: pane.screen() }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('P-013: 80x24, 120x40 and 200x60 keep a streamed reply whole across resizes', { timeout: 240_000 }, async () => {
    const prompt = `P13 stream ${randomUUID().slice(0, 8)}`;
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      await openComposer(pane);
      scriptedEngine.mode = 'stream';
      pane.write(prompt);
      pane.enter();
      // Resize at three points while chunks are still arriving 800 ms apart.
      await pane.waitFor('STREAM-A1', { timeoutMs: 60_000 });
      pane.resize(80, 24);
      await pane.waitFor('STREAM-B2', { timeoutMs: 10_000 });
      pane.resize(200, 60);
      await pane.waitFor('STREAM-C3', { timeoutMs: 10_000 });
      pane.resize(80, 24);
      await pane.waitFor('STREAM-E5', { timeoutMs: 10_000 });
      const chunks = scriptedEngine.streamChunks.map((chunk) => chunk.trim());
      for (const [cols, rows] of [[80, 24], [120, 40], [200, 60]] as const) {
        pane.resize(cols, rows);
        await pane.waitFor('Message — Enter send');
        // The reply wraps at narrow widths, so read it in screen order: every
        // chunk exactly once, in the order it streamed.
        await vi.waitFor(() => {
          const screen = pane.screen();
          const at = chunks.map((chunk) => screen.indexOf(chunk));
          expect(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])), screen).toBe(true);
          expect(chunks.every((chunk) => screen.split(chunk).length === 2), screen).toBe(true);
        }, { timeout: 10_000, interval: 100 });
      }
      expect(scriptedEngine.requests).toEqual([prompt]);
      console.info('PUI_P013_RESIZE_STREAM_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, prompt, frame: pane.screen() }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('P-013: first frame <= 2 s, key feedback p95 <= 100 ms, send feedback <= 250 ms', { timeout: 240_000 }, async () => {
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      const firstFrameMs = await renderedAfter(pane, () => {}, (screen) => screen.includes('· pui ·'), 10_000);
      if (optimised()) expect(firstFrameMs).toBeLessThanOrEqual(FIRST_FRAME_MS);

      await openComposer(pane, false);
      const keyMs = await keyFeedback(pane, 'p13keyfeedback0123456789abcdef');
      if (optimised()) expect(p95(keyMs)).toBeLessThanOrEqual(KEY_FEEDBACK_P95_MS);

      // The first message opens the session; the measured send is the second,
      // held in flight by the streaming fixture so its busy state is on screen.
      pane.reviewNextNewSession();
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      const second = `P13 send ${randomUUID().slice(0, 8)}`;
      pane.write(second);
      await pane.waitFor(second);
      scriptedEngine.mode = 'stream';
      const sendMs = await renderedAfter(pane, () => pane.enter(), (screen) =>
        screen.includes('Sending — awaiting acceptance') || screen.includes('Running — Enter queues'));
      if (optimised()) expect(sendMs).toBeLessThanOrEqual(SEND_FEEDBACK_MS);
      await pane.waitFor('STREAM-E5', { timeoutMs: 30_000 });
      console.info('PUI_P013_RESPONSIVENESS_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, optimised: optimised(), firstFrameMs, keyFeedbackP95Ms: p95(keyMs),
        keyFeedbackMaxMs: Math.max(...keyMs), keySamples: keyMs.length, sendFeedbackMs: sendMs,
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('P-013: a terminal that never answers the capability probe shows startup progress at once', { timeout: 120_000 }, async () => {
    // "Display meaningful startup progress immediately": held to the same
    // 250 ms as send feedback. The probe then times out (2 s) and PUI goes on.
    const STARTUP_PROGRESS_MS = SEND_FEEDBACK_MS;
    const spawnedAt = performance.now();
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40, silentTerminal: true });
    try {
      const progressMs = await renderedAfter(pane, () => {}, (screen) => screen.includes('Starting PUI'), 10_000);
      if (optimised()) expect(progressMs).toBeLessThanOrEqual(STARTUP_PROGRESS_MS);
      await pane.waitFor('· pui ·', { timeoutMs: 40_000 });
      const usableMs = performance.now() - spawnedAt;
      await pane.waitForGone('Starting PUI');
      console.info('PUI_P013_STARTUP_PROGRESS_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, optimised: optimised(), progressMs, usableMs,
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('P-013: a 40-turn session keeps key feedback in budget and memory bounded', { timeout: 600_000 }, async () => {
    const turns = 40;
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      await openComposer(pane);
      let rssAfterFirstMiB = 0;
      for (let turn = 1; turn <= turns; turn += 1) {
        const prompt = `P13 long ${turn} ${randomUUID().slice(0, 6)}`;
        pane.write(prompt);
        await pane.waitFor(prompt);
        pane.enter();
        await vi.waitFor(() => expect(scriptedEngine.requests).toHaveLength(turn), { timeout: 60_000, interval: 50 });
        await pane.waitFor('Message — Enter send', { timeoutMs: 30_000 });
        if (turn === 1) rssAfterFirstMiB = rssMiB(pane);
      }
      const rssAfterLastMiB = rssMiB(pane);
      const keyMs = await keyFeedback(pane, 'longsessionkeys0123456789');
      if (optimised()) expect(p95(keyMs)).toBeLessThanOrEqual(KEY_FEEDBACK_P95_MS);
      // A 40-turn transcript is kilobytes; growth beyond this is a leak.
      expect(rssAfterLastMiB - rssAfterFirstMiB).toBeLessThan(64);
      console.info('PUI_P013_LONG_SESSION_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, optimised: optimised(), turns, rssAfterFirstMiB, rssAfterLastMiB,
        keyFeedbackP95Ms: p95(keyMs),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  // One palette per mode, each named by the slots the always-drawn status bar
  // paints with in theme.rs (Theme::status_bar: `muted` on `status`).
  test.for([
    { theme: 'papercusp-light', muted: '110;125;120', status: '238;242;241' },
    { theme: 'papercusp-dark', muted: '134;150;146', status: '5;10;12' },
    { theme: 'high-contrast', muted: '200;200;200', status: '0;0;0' },
  ])('P-013: :theme $theme repaints the workbench in that palette', { timeout: 120_000 }, async ({ theme, muted, status }) => {
    const pane = new PuiPane(bin, operatorPort, home, { cols: 120, rows: 40 });
    try {
      await openAgentChat(pane);
      // `o` focused the composer, where `:` is text; leave it for the palette.
      pane.escape();
      await pane.waitFor('i type · v speak');
      const switchTo = async (name: string) => {
        pane.write(':');
        await pane.waitFor('Command (Esc closes)');
        pane.write(`theme ${name}`);
        pane.enter();
        await pane.waitForGone('Command (Esc closes)');
      };
      const mark = pane.rawSince(0).length;
      await switchTo(theme);
      await vi.waitFor(() => {
        const params = sgrParams(pane.rawSince(mark));
        expect(params.some((list) => list.includes(`38;2;${muted}`))).toBe(true);
        expect(params.some((list) => list.includes(`48;2;${status}`))).toBe(true);
      }, { timeout: 10_000, interval: 100 });
      await pane.waitFor('Agent Chat');
      console.info('PUI_P013_THEME_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256, theme, frame: pane.screen() }));
      // The active theme persists with the view state; leave the default.
      await switchTo('frost');
    } finally {
      await pane.stop().catch(() => {});
    }
  });
});

describe.skipIf(!scriptedEngine.real).sequential(`installed PUI with the real ${scriptedEngine.backend} engine`, () => {
  // The installed Codex Default mode excludes request_user_input. Its native
  // Plan-mode controls still need their own PUI acceptance before this case
  // can claim a positive Codex question result.
  test.skipIf(scriptedEngine.backend === 'codex')(
    'answers an actual native question through an installed PUI card',
    async () => {
      const manifest = installedManifest();
      const question = 'Would you like to keep or change the draft title?';
      // The accepted choice is the product outcome. Native providers may omit
      // the sentence's final period while still returning the exact choice.
      const expected = /^You chose: Change\.?$/;
      const questionTool = { claude: 'AskUserQuestion', codex: 'request_user_input', omp: 'ask' }[
        scriptedEngine.backend
      ];
      if (!questionTool) throw new Error(`No native question scenario for ${scriptedEngine.backend}`);
      const questionShape =
        scriptedEngine.backend === 'claude'
          ? 'Use multiSelect false.'
          : 'Use question id choice, with one selection allowed.';
      const request = `I want to try the choice dialog in this conversation. Please use ${questionTool} to ask me: ${question} Give me two choices, Keep and Change, under the header Choice. ${questionShape} Wait for me to choose. Then confirm my choice with the sentence "You chose: <selected label>."`;
      const pane = new PuiPane(bin, operatorPort, home);
      try {
        await openComposer(pane);
        pane.write(request);
        pane.enter();
        await waitForSavedTurn(request);
        const questionCards = () => pendingNativeCards().filter((pending) => !isSuToolApprovalCard(pending));
        const cardDeadline = Date.now() + 120_000;
        while (questionCards().length === 0 && Date.now() < cardDeadline) {
          pane.settleSuToolApproval();
          const lifecycle = scriptedEngine.engines.at(-1)?.adapter.host.descriptor().lifecycle;
          // An SU tool approval parks the turn too; the pane answers it.
          const approvalPending = pendingNativeCards().some(isSuToolApprovalCard);
          if (lifecycle && ['waiting-for-owner', 'failed', 'ended'].includes(lifecycle)
            && !(lifecycle === 'waiting-for-owner' && approvalPending)) {
            throw new Error(`The native turn reached ${lifecycle} without opening the requested question`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(questionCards()).toHaveLength(1);
        const engine = scriptedEngine.engines[0];
        const card = questionCards()[0];
        expect(card.prompt).toBe(question);
        if (card.presentation?.kind !== 'radio' || !card.presentation.options)
          throw new Error('The native question did not produce a PUI choice card');
        const choiceIndex = card.presentation.options.findIndex((option) => option.label === 'Change');
        expect(choiceIndex).toBeGreaterThanOrEqual(0);
        await pane.waitFor(question);
        await pane.waitFor('Operator asks');
        await pane.waitFor('Change');
        const questionFrame = pane.screen();
        expect(
          scriptedEngine.events.some(
            (event) => event.type === 'card' && event.phase === 'closed' && event.correlationId === card.correlationId,
          ),
        ).toBe(false);
        const repliesBefore = cardReplies.length;
        pane.write(String(choiceIndex + 1));
        await vi.waitFor(() => expect(cardReplies.length).toBeGreaterThan(repliesBefore), { timeout: 15_000, interval: 100 });
        expect(cardReplies[repliesBefore]).toMatchObject({ status: 200 });
        const chat = await waitForCorrelatedReply(request, expected);
        await pane.waitForReply(expected);
        const start = scriptedEngine.events.find(
          (event) => event.type === 'tool' && event.phase === 'started' && event.name === questionTool,
        );
        expect(scriptedEngine.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'card',
              phase: 'closed',
              correlationId: card.correlationId,
              resolution: 'submitted',
            }),
          ]),
        );
        // Codex exposes this built-in as a server request, without tool-item
        // start/completion notifications. Claude and OMP also expose tool events.
        if (scriptedEngine.backend !== 'codex') {
          if (!start || start.type !== 'tool') throw new Error('No actual native question tool was observed');
          expect(scriptedEngine.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: 'tool', phase: 'completed', callId: start.callId, isError: false }),
            ]),
          );
        }
        expect(scriptedEngine.events.filter((event) => event.type === 'card' && event.phase === 'opened'
          && !isSuToolApprovalCard(event.card))).toHaveLength(1);
        console.info(
          'PUI_INSTALLED_NATIVE_QUESTION_ACCEPTANCE',
          JSON.stringify({
            binary: bin,
            binarySha256,
            manifest,
            identity: engine.adapter.host.descriptor().identity,
            descriptor: engine.adapter.host.descriptor(),
            chatId: chat.id,
            question,
            selected: 'Change',
            card,
            cardReplies,
            suToolApprovals: pane.answeredSuToolApprovals,
            expected: expected.source,
            questionFrame,
            answeredFrame: pane.screen(),
            timeoutDegradations,
            toolEvents:
              start?.type === 'tool'
                ? scriptedEngine.events.filter((event) => event.type === 'tool' && event.callId === start.callId)
                : [],
          }),
        );
      } catch (error) {
        console.info(
          'PUI_INSTALLED_NATIVE_QUESTION_FAILURE',
          JSON.stringify({ ...pane.failureEvidence(), cardReplies, timeoutDegradations }),
        );
        throw error;
      } finally {
        await pane.stop().catch(() => {});
      }
    },
    300_000,
  );

  test('restores the same native conversation after the operator OS process exits', async () => {
    const manifest = installedManifest();
    const greetingReply = `PUI-PROCESS-${randomUUID()}`;
    const greeting = `Reply exactly ${greetingReply}. Do not use tools.`;
    const approvalEnabled = process.env.PUI_REAL_APPROVAL === '1';
    const approvalResult = `PUI-PERMISSION-FIXTURE-${randomUUID()}`;
    // Codex's `on-request` policy asks only when a command must leave its
    // workspace-write sandbox. The fixture home lives under the system temp
    // root, which Codex may write without escalation; targeting it would let
    // the command execute successfully while measuring no approval path at
    // all. Use a unique file beside (not inside) the checkout so every backend
    // must honor the explicit approval before the exact effect can occur.
    const approvalFixturePath = path.join(
      path.dirname(REPO_ROOT),
      `.pui-approval-fixture-${randomUUID()}.txt`,
    );
    // Ask for the ordinary outcome in ordinary language. Security-attestation
    // rhetoric and instructions not to inspect the task correctly make a real
    // provider stop and ask what is actually being tested, which exercises
    // provider policy rather than the PUI permission transport. The fixture
    // pre-assigns the task and the AUTO launch authorizes execution; native
    // toolApproval:'prompt' still requires the real Bash card below.
    const approvalRequest = `Continue the already-assigned PUI acceptance task ${REAL_APPROVAL_WORK_ITEM}. Use Bash to create the temporary fixture file '${approvalFixturePath}' containing exactly '${approvalResult}' followed by a newline.`;
    const first = await startOperatorProcess();
    const pane = new PuiPane(bin, first.port, home);
    const frames: Record<string, string> = {};
    let saved: SuSessionDescriptor | undefined;
    let chatId: string | undefined;
    let approvalCard: ReturnType<typeof pendingNativeCards>[number] | undefined;
    let approvalStart: Extract<SuSessionEvent, { type: 'tool'; phase: 'started' }> | undefined;
    let approvalEnd: Extract<SuSessionEvent, { type: 'tool'; phase: 'completed' }> | undefined;
    try {
      await openComposer(pane);
      if (approvalEnabled) {
        pane.write(approvalRequest);
        pane.enter();
        const approvalChat = await waitForSavedTurn(approvalRequest);
        const approvalCommand = approvalChat.transcript.find((turn) =>
          turn.content === approvalRequest)?.su_command?.command;
        if (approvalCommand?.type !== 'owner_turn') {
          throw new Error('Approval probe lacks a durable owner-turn receipt');
        }
        const approvalLabel = scriptedEngine.backend === 'omp' ? 'Confirm' : 'Approve';
        const pendingCards = () => pendingNativeCards(first.events);
        await vi.waitFor(
          () => expect(pendingCards().some((card) => card.prompt.includes(approvalFixturePath))).toBe(true),
          { timeout: 120_000, interval: 100 },
        );
        const targetApprovalCard = pendingCards().find((card) => card.prompt.includes(approvalFixturePath));
        if (!targetApprovalCard) throw new Error('Native tool approval card disappeared before it could be answered');
        approvalCard = targetApprovalCard;
        if (approvalCard.presentation?.kind !== 'radio' || !approvalCard.presentation.options) {
          throw new Error('Native tool approval did not produce a PUI choice card');
        }
        const approvalIndex = approvalCard.presentation.options.findIndex((option) => option.label === approvalLabel);
        expect(approvalIndex).toBeGreaterThanOrEqual(0);
        await pane.waitFor(approvalCard.prompt.split('\n', 1)[0] ?? approvalCard.prompt);
        await pane.waitFor(approvalLabel);
        frames.approval = pane.screen();
        const childCardReplies = () => first.responses.filter(({ path: responsePath }) =>
          responsePath.endsWith('/card-response'));
        const repliesBeforeApproval = childCardReplies().length;
        pane.write(String(approvalIndex + 1));
        await vi.waitFor(() => expect(childCardReplies()).toHaveLength(repliesBeforeApproval + 1), {
          timeout: 15_000,
          interval: 100,
        });
        expect(childCardReplies().at(-1)).toMatchObject({ status: 200 });
        await vi.waitFor(() => {
          approvalStart = first.events.find(
            (event): event is Extract<SuSessionEvent, { type: 'tool'; phase: 'started' }> =>
              event.type === 'tool' &&
              event.phase === 'started' &&
              JSON.stringify(event.input).includes(approvalFixturePath),
          );
          expect(approvalStart, 'the approved native command must be visible as a tool start').toMatchObject({
            turnId: approvalCommand.turnId,
            session: approvalCommand.target,
          });
          approvalEnd = first.events.find(
            (event): event is Extract<SuSessionEvent, { type: 'tool'; phase: 'completed' }> =>
              event.type === 'tool' && event.phase === 'completed' && event.callId === approvalStart?.callId,
          );
          expect(approvalEnd, 'the approved native command must finish successfully').toMatchObject({
            isError: false,
            turnId: approvalCommand.turnId,
            session: approvalCommand.target,
          });
        }, { timeout: 120_000, interval: 100 });
        expect(readFileSync(approvalFixturePath, 'utf8')).toBe(approvalResult + '\n');
        expect(first.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'card',
              phase: 'closed',
              correlationId: approvalCard.correlationId,
              resolution: 'submitted',
            }),
          ]),
        );
        // The approval clause is the authorized tool effect, not a provider's
        // optional prose after it. A post-tool provider error settles the host
        // in `waiting-for-owner` but deliberately does not render `· ready ·`;
        // wait on the producer-of-record lifecycle before sending the separate
        // greeting used by the restart/resume clause.
        await vi.waitFor(() => {
          expect(first.events.some((event) =>
            event.type === 'lifecycle' &&
            event.state === 'waiting-for-owner' &&
            event.sequence > (approvalEnd?.sequence ?? -1),
          )).toBe(true);
        }, { timeout: 120_000, interval: 100 });
        frames.approved = pane.screen();
      }
      pane.write(greeting);
      pane.enter();
      await pane.waitForReply(greetingReply);
      const chat = await waitForSavedTurn(greeting);
      chatId = chat.id;
      saved = first.descriptors.get(chatId);
      expect(saved?.identity.backend).toBe(scriptedEngine.backend);
      expect(saved?.identity.nativeSessionId).toBeTruthy();
      if (process.env.PUI_REAL_MODEL || process.env.PUI_REAL_MODE || process.env.PUI_REAL_PLAN === '1') {
        expect(saved).toMatchObject({
          accountRoute: process.env.PUI_REAL_ACCOUNT ?? 'default',
          carry: 'warm',
          modes: process.env.PUI_REAL_MODE ? [process.env.PUI_REAL_MODE] : [],
        });
        expect(saved?.model, 'the selected model must be the one that actually answered').toBeTruthy();
        const launchResponses = first.responses.filter((entry) => entry.path === '/api/adv/sessions/launch-su');
        expect(launchResponses).toEqual([
          expect.objectContaining({
            ...(process.env.PUI_REAL_MODEL ? { model: process.env.PUI_REAL_MODEL } : {}),
            mode: process.env.PUI_REAL_MODE,
            account: process.env.PUI_REAL_ACCOUNT ?? 'default',
            carry: 'warm',
          }),
        ]);
        expect(launchResponses[0]?.planSlug ?? undefined).toBe(
          process.env.PUI_REAL_PLAN === '1' ? REAL_PLAN : undefined,
        );
      }
      frames.beforeRestart = pane.screen();
    } catch (error) {
      console.info(
        'PUI_OPERATOR_PROCESS_FAILURE',
        JSON.stringify({
          output: first.output(),
          diagnostics: first.diagnostics,
          descriptors: [...first.descriptors.values()],
          events: first.events.slice(-30),
          readiness: first.readiness.slice(-10),
          responses: first.responses.slice(-20),
          screen: pane.screen(),
        }),
      );
      throw error;
    } finally {
      try {
        await pane.stop();
        await first.stop({ endSessions: false });
      } finally {
        rmSync(approvalFixturePath, { force: true });
      }
    }
    expect(first.shutdownStages).toContain('os-hard-exit-ready');
    // A process exit is observed before a NEW OS process binds the SAME port.
    // No in-memory host, registry, mock or JavaScript closure crosses this seam.
    await putViewState('Plans');
    const second = await startOperatorProcess(first.port);
    const resumedPane = new PuiPane(bin, second.port, home);
    let primaryFailure: { error: unknown } | null = null;
    try {
      expect(second.pid).not.toBe(first.pid);
      expect(second.instanceId).not.toBe(first.instanceId);
      await openAgentChat(resumedPane);
      resumedPane.escape();
      await resumedPane.waitFor('i type · v speak');
      resumedPane.write('l');
      await resumedPane.waitFor('Conversation — Enter select');
      frames.conversationPicker = resumedPane.screen();
      // Select the saved identity explicitly. The picker starts at row zero,
      // which can be another (empty) conversation in the production inventory.
      await resumedPane.waitFor(chatId!);
      const selectedHint = () => {
        const rows = resumedPane.screen().split('\n');
        const title = rows.findIndex((row) => row.includes('Conversation — Enter select'));
        const index = rows.findIndex((row, index) => index > title && row.includes('│> '));
        return index >= 0 ? (rows[index + 1] ?? '') : '';
      };
      for (let row = 0; row < 100 && !selectedHint().includes(chatId!); row++) {
        const previous = selectedHint();
        expect(previous, 'Conversation picker has no rendered selected row').not.toBe('');
        resumedPane.write('j');
        await vi.waitFor(() => expect(selectedHint()).not.toBe(previous), { timeout: 2_000, interval: 50 });
      }
      expect(selectedHint()).toContain(chatId!);
      frames.selectedConversation = resumedPane.screen();
      resumedPane.enter();
      resumedPane.write('i');
      await resumedPane.waitForReply(greetingReply);
      frames.history = resumedPane.screen();
      await resumedPane.waitFor('· ready ·', { timeoutMs: 120_000 });
      const resumedReply = new RegExp(`^RESUMED:\\s*${greetingReply}$`);
      // The optional approval probe precedes `greeting`, so "my first
      // greeting" is ambiguous there: a real model can correctly recall the
      // permission-fixture marker instead. Name the expected historical
      // marker while still requiring the resumed native conversation to have
      // retained it across the operator-process boundary.
      resumedPane.write(`Reply exactly RESUMED:${greetingReply}. Do not use tools.`);
      frames.beforeSubmit = resumedPane.screen();
      resumedPane.enter();
      await resumedPane.waitForReply(resumedReply);
      const resumed = second.descriptors.get(chatId!);
      expect(resumed).toMatchObject({
        identity: saved!.identity,
        model: saved!.model,
        accountRoute: saved!.accountRoute,
        carry: saved!.carry,
        modes: saved!.modes,
        runtimeGeneration: saved!.runtimeGeneration + 1,
      });
      frames.resumed = resumedPane.screen();
      expect(
        second.events.some(
          (event) =>
            event.type === 'transcript' &&
            event.role === 'assistant' &&
            event.phase === 'completed' &&
            resumedReply.test(event.content ?? ''),
        ),
      ).toBe(true);
      console.info(
        'PUI_OPERATOR_PROCESS_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          manifest,
          first: { pid: first.pid, instanceId: first.instanceId },
          second: { pid: second.pid, instanceId: second.instanceId },
          port: second.port,
          saved,
          resumed,
          frames,
          readiness: second.readiness,
          approval: approvalCard
            ? {
                card: approvalCard,
                start: approvalStart,
                end: approvalEnd,
                fixturePath: approvalFixturePath,
                result: approvalResult,
                replies: first.responses.filter(({ path: responsePath }) => responsePath.endsWith('/card-response')),
              }
            : null,
          diagnostics: [...first.diagnostics, ...second.diagnostics],
        }),
      );
    } catch (error) {
      primaryFailure = { error };
      console.info(
        'PUI_OPERATOR_PROCESS_FAILURE',
        JSON.stringify({
          output: second.output(),
          diagnostics: second.diagnostics,
          descriptors: [...second.descriptors.values()],
          events: second.events.slice(-30),
          responses: second.responses.slice(-20),
          frames,
          readiness: second.readiness,
          screen: resumedPane.screen(),
        }),
      );
      throw error;
    } finally {
      await preservePrimaryFailureDuringCleanup(primaryFailure, [
        { label: 'pui-pane', run: () => resumedPane.stop() },
        { label: 'operator-process', run: () => second.stop() },
      ]);
    }
    expect(second.shutdownStages).toContain('os-hard-exit-ready');
  }, 600_000);

  test('greeting, real file tool, interrupt and continued reply stay in one first-party session', async () => {
    const manifest = installedManifest();
    const nonce = randomUUID();
    const greetingReply = `PUI-HELLO-${nonce}`;
    const greeting = `Hi. Reply with exactly ${greetingReply} and no other text.`;
    // The answer is intentionally absent from the request: only reading this
    // newly generated file can supply the expected result.
    const fileResult = `PUI-FILE-${randomUUID()}`;
    const fixturePath = path.join(home, `read-${nonce}.txt`);
    writeFileSync(fixturePath, fileResult + '\n');
    const fileRequest = `Use your file-reading tool to inspect ${fixturePath}, then reply with its contents. Do not modify any file.`;
    const longRequest = `For interruption check PUI-CANCELLED-${nonce}, count from 1 through 10000, one number per line. Do not summarize or use tools.`;
    const followupReply = `PUI-CONTINUED-${nonce}`;
    const followup = `Reply with exactly ${followupReply} and no other text. Do not resume the interrupted task.`;
    const pane = new PuiPane(bin, operatorPort, home);
    const frames: Record<string, string> = {};
    let streamingEvidence: Record<string, unknown> | undefined;
    try {
      await openComposer(pane);
      pane.write(greeting);
      pane.enter();
      const firstChat = await waitForCorrelatedReply(greeting, greetingReply);
      await pane.waitForReply(greetingReply);
      frames.greeting = pane.screen();
      const engine = scriptedEngine.engines[0];
      expect(engine?.pid()).toBeGreaterThan(0);
      const identity = structuredClone(engine.adapter.host.descriptor().identity);
      expect(identity.backend).toBe(scriptedEngine.backend);
      expect(identity.nativeSessionId).toBeTruthy();
      expect(engine.adapter.host.descriptor().model, 'show the model that actually answered').toBeTruthy();
      expect(engine.adapter.host.descriptor().accountRoute).toBe(process.env.PUI_REAL_ACCOUNT ?? 'default');
      if ('nativeSession' in engine) {
        expect(engine.nativeSession()).toMatchObject({ backend: scriptedEngine.backend, exactResumeSupported: true });
      }

      // The fixture is outside the session's working directory, so a native
      // read asks first; the owner approves exactly that read.
      pane.approveNativeReadOf(fixturePath);
      pane.write(fileRequest);
      pane.enter();
      await pane.waitFor(fileResult, { timeoutMs: 120_000 });
      await pane.waitFor('Message — Enter send', { timeoutMs: 120_000 });
      frames.file = pane.screen();
      const readStart = scriptedEngine.events.find(
        (event): event is Extract<SuSessionEvent, { type: 'tool'; phase: 'started' }> =>
          event.type === 'tool' && event.phase === 'started' && JSON.stringify(event.input).includes(fixturePath),
      );
      expect(readStart, 'the model must actually request the generated fixture').toBeDefined();
      expect(pane.screen()).toContain(readStart!.name);
      const readEnd = scriptedEngine.events.find(
        (event) =>
          event.type === 'tool' &&
          event.phase === 'completed' &&
          event.callId === readStart?.callId &&
          JSON.stringify(event.output).includes(fileResult),
      );
      expect(readEnd, 'the real tool result must return in the same turn').toMatchObject({ turnId: readStart?.turnId });

      pane.write(longRequest);
      pane.enter();
      const longChat = await waitForSavedTurn(longRequest);
      const longCommand = longChat.transcript.find((turn) => turn.content === longRequest)?.su_command?.command;
      if (longCommand?.type !== 'owner_turn') throw new Error('Interrupt target lacks an owner-turn receipt');
      // The engine's completed owner-turn receipt follows the native input
      // acknowledgement, not model completion. Interrupt real inference after
      // that receipt; a refused sleep command cannot stand in for running work.
      await vi.waitFor(
        () =>
          expect(scriptedEngine.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'command_result',
                commandId: longCommand.commandId,
                commandType: 'owner_turn',
                status: 'completed',
                session: longCommand.target,
              }),
            ]),
          ),
        { timeout: 120_000, interval: 100 },
      );
      // Wait on the transcript title's stable streaming state. The composer
      // footer can legitimately be replaced by a higher-priority pending-ack,
      // card or approval branch while the same native turn is already running.
      // P-007's focused case above separately pins the queue-affordance text;
      // the `not.toContain('Message — Enter send')` assertion below keeps this
      // journey's input-lock contract independent of which footer branch owns.
      await pane.waitFor('Agent Chat · Running · Ctrl+X cancel');
      await vi.waitFor(
        () => {
          const partialText = scriptedEngine.events
            .flatMap((event) =>
              event.type === 'transcript' &&
              event.role === 'assistant' &&
              event.phase === 'delta' &&
              event.turnId === longCommand.turnId
                ? [event.content]
                : [],
            )
            .join('');
          expect(partialText, 'native text must reach the host before completion').toMatch(/\b1\s+2\s+3\b/);
          // Read the FIRST pane column, not one bar off each end: the agent-chat pane
          // is rendered beside the Presence rail (`│5302 …││● claude  su │`), so
          // stripping a single leading/trailing `│` leaves the rail's text attached and
          // NO line can ever match /^\d+$/. Splitting on `│` takes the agent-chat cell in
          // both the railed and the narrow single-pane layout (apps/tui/src/ui.rs).
          const visibleNumbers = pane
            .screen()
            .split('\n')
            .map((line) => (line.split('│')[1] ?? '').trim())
            .filter((line) => /^\d+$/.test(line))
            .map(Number);
          // Positive control: an EMPTY scrape makes the .some() below false, which is
          // indistinguishable from "the PUI painted nothing". Fail on the real cause —
          // the scrape measured nothing — instead of blaming the product for a layout change.
          expect(
            visibleNumbers.length,
            'screen scrape found no numeric lines: the pane layout changed and this assertion is measuring nothing',
          ).toBeGreaterThan(0);
          expect(
            visibleNumbers.some(
              (value, index) => visibleNumbers[index + 1] === value + 1 && visibleNumbers[index + 2] === value + 2,
            ),
            'the installed PUI must paint incremental assistant text',
          ).toBe(true);
          expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
          expect(
            scriptedEngine.events.some(
              (event) =>
                event.type === 'transcript' &&
                event.role === 'assistant' &&
                event.phase === 'completed' &&
                event.turnId === longCommand.turnId,
            ),
          ).toBe(false);
          streamingEvidence = {
            turnId: longCommand.turnId,
            observedAt: new Date().toISOString(),
            partialText: partialText.slice(0, 200),
            visibleNumbers: visibleNumbers.slice(0, 8),
            lifecycle: 'running',
            completed: false,
          };
        },
        { timeout: 120_000, interval: 50 },
      );
      expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
      expect(
        scriptedEngine.events.some(
          (event) =>
            event.type === 'transcript' &&
            event.role === 'assistant' &&
            event.phase === 'completed' &&
            event.turnId === longCommand.turnId,
        ),
        'the native long reply must still be running before the PUI interrupt',
      ).toBe(false);
      frames.running = pane.screen();
      pane.interrupt();
      await vi.waitFor(() => expect(commandPosts.some((command) => command.type === 'interrupt')).toBe(true), {
        timeout: 15_000,
        interval: 100,
      });
      await pane.waitFor('Message — Enter send', { timeoutMs: 30_000 });
      frames.interrupted = pane.screen();
      pane.write(followup);
      pane.enter();
      const finalChat = await waitForCorrelatedReply(followup, followupReply);
      await pane.waitForReply(followupReply);
      frames.followup = pane.screen();
      expect(finalChat.id).toBe(firstChat.id);
      expect(engine.adapter.host.descriptor().identity).toEqual(identity);
      expect(scriptedEngine.engines).toHaveLength(1);
      expect(commandPosts.filter((command) => command.type === 'owner_turn').map((command) => command.content)).toEqual(
        [greeting, fileRequest, longRequest, followup],
      );
      expect(commandReplies.every((reply) => reply.status === 202 && !reply.replayed)).toBe(true);
      // RPC backends obtain their native identity asynchronously after the
      // launch response. The real greeting above proves the later handshake
      // and persisted native resume handle, independently of response timing.
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')).toEqual([
        expect.objectContaining({ count: 1, attachedEngine: true, transport: 'structured' }),
      ]);

      // Inspect this launch's process family only, without printing argv or
      // touching an existing human/peer terminal. The real CLI has pipe stdio;
      // only the PUI process is attached to our allocated terminal.
      const processes: Array<{ pid: number; tty: string; name: string }> = [];
      const pending = [engine.pid()!, ...(await childPids(pane.pty.pid))];
      const seen = new Set<number>();
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const rows = await processRows(['-o', 'tty=,comm=', '-p', String(pid)]);
        if (rows.trim()) {
          const [tty, ...name] = rows.trim().split(/\s+/);
          processes.push({ pid, tty, name: name.join(' ') });
        }
        pending.push(...(await childPids(pid)));
      }
      expect(processes.length).toBeGreaterThan(0);
      expect(processes.every((proc) => proc.tty === '?')).toBe(true);
      expect(
        processes.some((proc) => /zellij|tmux|xterm|gnome-terminal|konsole|wezterm|alacritty|kitty/.test(proc.name)),
      ).toBe(false);
      // Lose the native process and its in-memory host, then reconnect using
      // the installed PUI's conversation picker. This tests the production
      // resume door; the Hono fixture itself remains in the same process.
      const savedDescriptor = engine.adapter.host.descriptor();
      await pane.stop();
      await engine.close();
      await engine.done;
      const teardownRows = await db.adminSql`
        SELECT s.session_id, s.omp_thread_id, s.ended_at, s.pid AS native_pid,
               p.pid AS presence_pid, p.host AS presence_host,
               p.last_active_at <= s.ended_at AS activity_before_end,
               p.heartbeat_at <= s.ended_at AS heartbeat_before_end,
               EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated WHERE taken_by = s.coord_owner_id) AS held_features,
               EXISTS (SELECT 1 FROM harness_shared.engineer_issues WHERE assignee = s.coord_owner_id) AS held_issues,
               EXISTS (SELECT 1 FROM harness_shared.work_item_claims WHERE owner = s.coord_owner_id) AS held_claims,
               EXISTS (SELECT 1 FROM harness_shared.plan_item_claims WHERE owner = s.coord_owner_id) AS held_plan_claims
        FROM harness_shared.adv_sessions s
        LEFT JOIN harness_shared.coord_presence p ON p.owner_id = s.coord_owner_id
        WHERE s.id = ${identity.advSessionId}`;
      console.info('PUI_NATIVE_TEARDOWN_DIAGNOSTIC', JSON.stringify(teardownRows));
      engine.adapter.dispose();
      await putViewState('Plans');
      const resumedPane = new PuiPane(bin, operatorPort, home);
      let resumedDescriptor;
      const resumePrompt = `Reply exactly RESUMED:${greetingReply}. Do not use tools.`;
      const resumedReply = `RESUMED:${greetingReply}`;
      // Recall of the unknown marker is the assertion, not whether a model
      // inserts whitespace after the label. The marker itself stays exact.
      const resumedReplyPattern = new RegExp(`^RESUMED:\\s*${greetingReply}$`);
      try {
        await resumedPane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        resumedPane.write('o');
        // Opening Agent Chat starts at the new-conversation composer. Select
        // the saved conversation before expecting any of its history.
        await resumedPane.waitFor(`pot ${HARNESS} · role operator · session new`);
        resumedPane.escape();
        await resumedPane.waitFor('i type · v speak');
        resumedPane.write('l');
        await resumedPane.waitFor('Conversation — Enter select');
        resumedPane.enter();
        await vi.waitFor(() => expect(scriptedEngine.engines).toHaveLength(2), { timeout: 120_000, interval: 100 });
        const resumedEngine = scriptedEngine.engines[1];
        await resumedEngine.ready;
        expect(resumedEngine.adapter.host.recent.map(({ event }) => event)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'transcript',
              phase: 'completed',
              role: 'assistant',
              content: followupReply,
            }),
          ]),
        );
        resumedPane.write('i');
        await resumedPane.waitForReply(followupReply);
        frames.history = resumedPane.screen();
        resumedDescriptor = resumedEngine.adapter.host.descriptor();
        expect(resumedDescriptor).toMatchObject({
          identity,
          carry: savedDescriptor.carry,
          modes: savedDescriptor.modes,
          accountRoute: savedDescriptor.accountRoute,
          model: savedDescriptor.model,
          runtimeGeneration: savedDescriptor.runtimeGeneration + 1,
        });
        resumedPane.write(resumePrompt);
        resumedPane.enter();
        const resumedChat = await waitForCorrelatedReply(resumePrompt, resumedReplyPattern);
        await resumedPane.waitForReply(resumedReplyPattern);
        expect(resumedChat.id).toBe(firstChat.id);
        frames.resumed = resumedPane.screen();
      } catch (cause) {
        console.info('PUI_INSTALLED_RESUME_FAILURE', JSON.stringify(resumedPane.failureEvidence()));
        throw cause;
      } finally {
        await resumedPane.stop();
      }
      expect(namedQueryRequests).not.toContain('network.board');
      expect(pipelineCellRequests).toEqual([]);
      console.info(
        'PUI_INSTALLED_REAL_ENGINE_ACCEPTANCE',
        JSON.stringify({
          binary: bin,
          binarySha256,
          manifest,
          chatId: finalChat.id,
          identity,
          frames,
          greetingReply,
          fileResult,
          followupReply,
          resumedReply,
          resumedDescriptor,
          readStart,
          readEnd,
          nativeReadApprovals: pane.answeredNativeReadApprovals,
          streamingEvidence,
          commandTypes: commandPosts.map((command) => command.type),
          processes,
          traffic: sessionTraffic,
          initializeWarnings,
          optionalMemoryWarnings,
          configurationWarnings,
          intentPivotWarnings,
          timeoutDegradations,
          nativeFrames: nativeFrameDiagnostics,
          nativeProviderEvents,
          assistantReplies: scriptedEngine.events.filter(
            (event) =>
              event.type === 'transcript' &&
              event.phase === 'completed' &&
              event.role === 'assistant' &&
              event.channel === 'text',
          ),
        }),
      );
    } catch (cause) {
      const nativeState = await readOmpDiagnosticState?.().catch((error: Error) => ({ stateReadError: error.message }));
      console.info(
        'PUI_INSTALLED_REAL_ENGINE_FAILURE',
        JSON.stringify({
          backend: scriptedEngine.backend,
          binary: bin,
          binarySha256,
          frames,
          nativeState,
          intentPivotWarnings,
          timeoutDegradations,
          ...pane.failureEvidence(),
        }),
      );
      throw cause;
    } finally {
      await pane.stop().catch(() => {});
    }
  }, 600_000);
});
