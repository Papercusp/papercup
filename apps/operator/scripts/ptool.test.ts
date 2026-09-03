import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  callToolWithPressureRetry,
  callToolWithReplayRecovery,
  buildCallToolParams,
  buildMcpUrl,
  connectWithLocalRetry,
  listToolsWithLocalRetry,
  escapeJsonStringControls,
  importSdkModuleWithInstallAwareness,
  parseArgs,
  parseJsonInput,
  resolveContextTier,
  resolvePayloadHarnessScope,
  resolveHarnessScope,
  resolveTokenPath,
  resolveTokenPaths,
  formatToolCallFailure,
  formatToolCatalogFailure,
  isLoopPressureShed,
  isReadOnlyTool,
  isTransportFailure,
  printResult,
  stdoutDeliveryError,
  PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_COORD_ORIENT_TIMEOUT_MS,
  PTOOL_EVENTS_AWAIT_TIMEOUT_MS,
  PTOOL_FOREGROUND_TOOL_TIMEOUT_MS,
  PTOOL_AGENT_LAUNCH_TIMEOUT_MS,
  PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
  PTOOL_PLANS_GET_TIMEOUT_MS,
  PTOOL_PLANS_NEW_TIMEOUT_MS,
  PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_GET_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS,
  PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS,
  PTOOL_POST_CONNECT_RETRIES,
  PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS,
  PTOOL_RETRY_JITTER_MS,
  PTOOL_READ_ONLY_POST_CONNECT_RETRIES,
  PTOOL_SCORECARD_EMIT_TIMEOUT_MS,
  PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS,
  PTOOL_TRUNCATED_RESULT_MESSAGE,
  resultToText,
  retryWaitMsWithJitter,
  sanitizeJsonText,
  scratchUriToPath,
  shouldPrintRawResult,
  timeoutForTool,
  unwrapOutputEnvelope,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
} from './ptool.mjs';

describe('ptool bootstrap dependencies', () => {
  it('declares the MCP SDK directly in the operator workspace', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
  });

  it('keeps the standalone shim free of the install-safe reader guard', () => {
    const installer = readFileSync(
      new URL('./install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    const shimStart = installer.indexOf('PTOOL_LAUNCHER=');
    const shimEnd = installer.indexOf('\n# 5. Verify the endpoint', shimStart);
    const ptoolInstallBlock = installer.slice(shimStart, shimEnd);

    expect(shimStart).toBeGreaterThan(-1);
    expect(shimEnd).toBeGreaterThan(shimStart);
    expect(ptoolInstallBlock).toContain('exec node "${PTOOL_LAUNCHER}" "\\$@"');
    expect(ptoolInstallBlock).not.toContain('--exec-under-lock');
    expect(ptoolInstallBlock).not.toContain('npm-install-safe.mjs');
  });

  it('atomically replaces standalone launchers to prevent ETXTBSY races (EI-21566808495780594)', () => {
    const installer = readFileSync(
      new URL('./install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    const helperStart = installer.indexOf('install_executable_atomic()');
    const wrapperStart = installer.indexOf('# 4g. Install the `psu` command', helperStart);
    const verifyStart = installer.indexOf('\n# 5. Verify the endpoint', wrapperStart);
    const helper = installer.slice(helperStart, wrapperStart);
    const wrappers = installer.slice(wrapperStart, verifyStart);

    expect(helperStart).toBeGreaterThan(-1);
    expect(wrapperStart).toBeGreaterThan(helperStart);
    expect(verifyStart).toBeGreaterThan(wrapperStart);
    expect(helper).toContain('temporary="$(mktemp "${destination}.tmp.XXXXXX")"');
    expect(helper).toContain('if ! cat > "$temporary"; then');
    expect(helper).toContain('if ! mv -f -- "$temporary" "$destination"; then');
    expect(wrappers.match(/install_executable_atomic "\$PSU_PATH" 755/g)?.length).toBe(1);
    expect(wrappers.match(/install_executable_atomic "\$PTOOL_PATH" 755/g)?.length).toBe(1);
    expect(wrappers).not.toMatch(/cat\s*>\s*"\$(?:PSU|PTOOL)_PATH"/);
  });
});

describe('ptool MCP identity binding', () => {
  it('accepts an explicit idempotency receipt in both CLI flag forms', () => {
    expect(parseArgs(['work_items:checkpoint', '--idempotency-key', 'receipt-1']).idempotencyKey)
      .toBe('receipt-1');
    expect(parseArgs(['events:cancel', '--idempotency-key=receipt-2']).idempotencyKey)
      .toBe('receipt-2');
  });

  it('carries the live PAPERCUSP_SID as the MCP client query parameter', () => {
    const url = buildMcpUrl('http://127.0.0.1:3170', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      client: 'su-live-owner-123',
    });

    expect(url.searchParams.get('client')).toBe('su-live-owner-123');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
    expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
  });

  it('defaults direct sessions to trimmed payloads and allows an explicit full escape hatch', () => {
    expect(resolveContextTier({ env: { NODE_ENV: 'test' } })).toBe('trimmed');
    expect(resolveContextTier({ env: { NODE_ENV: 'test', PAPERCUSP_CONTEXT_TIER: ' full ' } })).toBe('full');
    expect(buildMcpUrl('http://127.0.0.1:3170', { contextTier: 'full' }).searchParams.get('ctx_tier'))
      .toBe('full');
  });

  it('inherits the active harness from the su environment, with an explicit flag taking precedence', () => {
    expect(resolveHarnessScope({ env: { PAPERCUSP_HARNESS_SLUG: ' papercusp ' } })).toBe('papercusp');
    expect(resolveHarnessScope({
      harness: 'cli-harness',
      env: { PAPERCUSP_HARNESS_SLUG: 'papercusp' },
    })).toBe('cli-harness');
    expect(resolveHarnessScope({ env: { NODE_ENV: 'test' } })).toBeNull();
  });

  it('derives a direct payload harness before the inherited environment scope', () => {
    const payload = { harness: ' papercusp ' };
    const env = { PAPERCUSP_HARNESS_SLUG: 'sb-devboard-hive' };

    expect(resolvePayloadHarnessScope(payload, { toolName: 'coord:declare-intent' })).toBe('papercusp');
    expect(resolveHarnessScope({ payload, toolName: 'coord:declare-intent', env })).toBe('papercusp');
    expect(resolveHarnessScope({
      harness: 'cli-harness',
      payload,
      toolName: 'coord:declare-intent',
      env,
    })).toBe('cli-harness');
  });

  it('derives a tools:invoke target harness from its nested args', () => {
    const payload = {
      name: 'coord:declare-intent',
      args: { harness: 'papercusp' },
    };
    const env = { PAPERCUSP_HARNESS_SLUG: 'sb-devboard-hive' };

    expect(resolvePayloadHarnessScope(payload, { toolName: 'tools:invoke' })).toBe('papercusp');
    expect(resolveHarnessScope({ payload, toolName: 'tools:invoke', env })).toBe('papercusp');
  });

  it('rejects unsupported tool-specific flags instead of silently dropping them', () => {
    expect(() => parseArgs([
      'fleet:assignments',
      '--json',
      '-',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
      '--fleet=goal-drain-work-on-everything-070565',
    ])).toThrow(
      'unknown flag --fleet=goal-drain-work-on-everything-070565; tool-specific arguments must be supplied in the JSON payload via --json, --json-file, or --json -',
    );
    expect(() => parseArgs(['fleet:assignments', '--fleet', 'goal-drain-work-on-everything-070565']))
      .toThrow('unknown flag --fleet;');
  });

  it('keeps the quoting-safe JSON-body scope form supported', () => {
    expect(parseArgs([
      'fleet:assignments',
      '--json',
      '-',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
    ])).toMatchObject({
      tool: 'fleet:assignments',
      json: '-',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });
  });
});

describe('ptool bearer-token resolution', () => {
  it('keeps explicit and environment token overrides authoritative', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_MCP_TOKEN_FILE: '/run/papercusp/explicit-token',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };

    expect(resolveTokenPaths({
      tokenFile: '/tmp/cli-token',
      env,
      home: '/home/tester',
    })).toEqual(['/tmp/cli-token']);
    expect(resolveTokenPaths({ env, home: '/home/tester' }))
      .toEqual(['/run/papercusp/explicit-token']);
  });

  it('falls back to the shared host token when an isolated workspace token is absent', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };
    const paths = resolveTokenPaths({ env, home: '/home/tester' });

    expect(paths).toEqual([
      '/home/tester/.papercusp-workspaces/demo/.papercusp/superuser-token',
      '/home/tester/.papercusp/superuser-token',
    ]);
    expect(resolveTokenPath({ env, home: '/home/tester' })).toBe(paths[0]);
  });
});

describe('ptool call deadlines', () => {
  it('keeps the normal liveness ceiling while allowing durable continuations to return', () => {
    expect(timeoutForTool('coord:send')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21863905839650704: coord:declare-intent declares no timeoutSec (bound
    // only by the flat 55s MCP_DEADLINE_MS floor), and a reporter observed the
    // flat 30s client cutoff abort the call with "mutation may have executed"
    // while the presence write had already landed. Cover both transport routes.
    expect(timeoutForTool('coord:declare-intent')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:declare-intent',
      args: { intent: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('fleet:launch-on-plan')).toBe(300_000);
    expect(timeoutForTool('tools:invoke', { name: 'fleet:launch-on-plan' })).toBe(300_000);
    // EI-21831468700319864: fleet:wind-down inherits the 60s dispatch default;
    // cover direct and tools:invoke-wrapped calls so the client deadline does
    // not race its durable control-state mutation.
    expect(timeoutForTool('fleet:wind-down')).toBe(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'fleet:wind-down',
      args: { fleet: 'nonp2p-bug-drain-luna-max-50', reason: 'test timeout mapping' },
    })).toBe(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS);
    expect(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // EI-21388931083718076: the respawn orchestration's client deadline must outlive
    // its 660s server budget (+5s transport buffer) — a 30s client abort turned five
    // server-side-successful respawns into -32001 outcome-unknown.
    expect(timeoutForTool('fleet:respawn-member')).toBe(675_000);
    expect(timeoutForTool('tools:invoke', { name: 'fleet:respawn-member' })).toBe(675_000);
    expect(timeoutForTool('fleet:require-checkpoint')).toBe(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'fleet:require-checkpoint',
      args: { member: 'su-member', itemId: 'WI-123', waitSec: 300 },
    })).toBe(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS);
    expect(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS).toBeGreaterThan(335_000);
    expect(timeoutForTool('git-sync:run')).toBe(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS);
    expect(timeoutForTool('backup:snapshot_create')).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('templates:new-app')).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('scorecards:emit')).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    // WI-2944 / EI-21637077415806005: a 30s client cutoff on a visible
    // capability:launch-agent left the first handler running, then the stale
    // Windows ptool replayed the mutation on a fresh MCP session. Pin both
    // direct and deferred routes above the transport cap; the replay guard
    // below independently proves mutations cannot reconnect and re-dispatch.
    expect(timeoutForTool('capability:launch-agent')).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
    expect(PTOOL_AGENT_LAUNCH_TIMEOUT_MS).toBeGreaterThan(65_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'capability:launch-agent',
      args: { agent: 'claude', headless: false },
    })).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
    expect(timeoutForTool('computer:provision_desktop')).toBe(60_000);
    expect(timeoutForTool('events:await')).toBe(PTOOL_EVENTS_AWAIT_TIMEOUT_MS);
    expect(timeoutForTool('plans:get')).toBe(PTOOL_PLANS_GET_TIMEOUT_MS);
    expect(timeoutForTool('plans:new')).toBe(PTOOL_PLANS_NEW_TIMEOUT_MS);
    // EI-21562635786542847: carry-respawn's 120s server budget must also
    // apply when the call is wrapped by tools:invoke.
    expect(timeoutForTool('session:request-compaction')).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'session:request-compaction',
      args: { focus: 'resume the current lane' },
    })).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    // EI-21567372634210816: plans:start has a 60s dispatcher default while
    // ptool's ordinary client deadline is 30s; cover both transport routes.
    expect(timeoutForTool('plans:start')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:start',
      args: { slug: 'fleet-worker-lifecycle-convergence-2026-08-26', harness: 'papercusp' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(PTOOL_PLANS_NEW_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('plans:set-plan-status')).toBe(60_000);
    expect(timeoutForTool('work_items:get')).toBe(PTOOL_WORK_ITEMS_GET_TIMEOUT_MS);
    expect(timeoutForTool('activity:recent')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('events:status')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('work_items:complete')).toBe(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS);
    expect(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS).toBeGreaterThan(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21832411975767034: cover direct and tools:invoke-wrapped create calls
    // so the client deadline cannot drift back to the flat 30s cutoff.
    expect(timeoutForTool('work_items:create')).toBe(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:create',
      args: { kind: 'task', title: 'timeout mapping regression' },
    })).toBe(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS);
    expect(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('activity:tool-log')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('sessions:search')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('release:deploy')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('events:cancel')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('work_items:checkpoint')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21565982575605857: required friction filing must outlive the MCP
    // transport cap on both the direct and deferred tools:invoke routes; a
    // flat 30s deadline reports the write outcome as unknown while capture
    // is still in flight.
    expect(timeoutForTool('improvements:capture')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21863905839650704: loop:arm declares no timeoutSec and performs a
    // compound admission (claim + inbox-wake arming + reachability probe);
    // a reporter's combined "coord:declare-intent and loop:arm" call surfaced
    // the identical ambiguous-outcome failure for this tool too.
    expect(timeoutForTool('loop:arm')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'loop:arm',
      args: { intervalSec: 60, goal: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('loop:checkpoint')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('loop:end')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'loop:end',
      args: {},
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-21281814895308307' },
    })).toBe(PTOOL_WORK_ITEMS_GET_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'activity:recent',
      args: { harness: 'papercusp', limit: 50 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:status',
      args: { meter: true },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:complete',
      args: { id: 'EI-21391577717750595', state: 'done' },
    })).toBe(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'activity:tool-log',
      args: { owner: 'su-04f38', max_lines: 20 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'sessions:search',
      args: { query: 'timeout', mode: 'verbatim', limit: 1, context: 0 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:deploy',
      args: { op: 'status' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:cancel',
      args: { delivery_id: 164257 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:checkpoint',
      args: { id: 'WI-41055', checkpoint: 'resume' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'improvements:capture',
      args: { title: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('coord:orient')).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('release:trace')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('coord:presence')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21562940235111441: the fleet-scope reconciliation has its own 30s
    // server watchdog; ptool must leave enough time for its typed timeout
    // result to cross the MCP transport instead of racing it at 30s.
    expect(timeoutForTool('scheduler:get_next')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:get',
      args: { slug: 'nonp2p-bug-drain-fleet-2026-08-16', harness: 'papercusp' },
    })).toBe(PTOOL_PLANS_GET_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:new',
      args: { slug: 'anti-babysitting-monitor-enforcement-2026-08-25', title: 'monitor' },
    })).toBe(PTOOL_PLANS_NEW_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:trace',
      args: { sha: '83805ce3' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:presence',
      args: { owner: 'su-b215e3bd-66d1-42ce-8186-55df285710be' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scheduler:get_next',
      args: { harness: 'papercusp' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21574172453638335: locks:acquire's bounded blocking wait must not
    // fall through to the flat 30s client deadline, including via tools:invoke.
    expect(timeoutForTool('locks:acquire', {
      paths: ['packages/example.ts'],
      intent: 'test lock timeout mapping',
      wait: { max_sec: 45 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'locks:acquire',
      args: {
        paths: ['packages/example.ts'],
        intent: 'test deferred lock timeout mapping',
        wait: { max_sec: 300 },
      },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('locks:acquire')).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:set-plan-status',
      args: { slug: 'some-plan', status: 'shipped', expectedCurrent: 'ready' },
    })).toBe(60_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:orient',
      args: {},
    })).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'computer:provision_desktop',
      args: { pot: 'papercusp', apps: [] },
    })).toBe(60_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'backup:snapshot_create',
      args: { reason: 'pre_destructive' },
    })).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:send',
      args: {},
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'templates:new-app',
      args: { template: 'papercusp-android-app', slug: 'demo' },
    })).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scorecards:emit',
      args: { rubricRef: 'acceptance-demo' },
    })).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:await',
      args: { event: 'wi-40086-qualified-current-tip' },
    })).toBe(PTOOL_EVENTS_AWAIT_TIMEOUT_MS);
    expect(PTOOL_EVENTS_AWAIT_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // scorecards:emit declares 900s; the MCP transport adds a 5s buffer.
    expect(PTOOL_SCORECARD_EMIT_TIMEOUT_MS).toBeGreaterThan(905_000);
  });

  it('passes the selected deadline to both MCP timeout guards', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    await callToolWithPressureRetry(
      { callTool },
      { name: 'git-sync:run', arguments: {} },
      { timeoutMs: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS, maxAttempts: 1 },
    );

    expect(callTool).toHaveBeenCalledWith(
      { name: 'git-sync:run', arguments: {} },
      undefined,
      {
        timeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
        maxTotalTimeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
      },
    );
  });
});

describe('ptool tools/call failure diagnostics', () => {
  it('identifies a catalog timeout as pre-dispatch and safe to retry', () => {
    const error = Object.assign(new Error('Request timed out'), { code: -32001 });
    const message = formatToolCatalogFailure('coord:read', error);

    expect(message).toContain('tool catalog discovery failed for requested tool coord:read');
    expect(message).toContain('failure_stage=tools/list');
    expect(message).toContain('no named tool was dispatched');
    expect(message).toContain('retrying this CLI invocation is safe');
    expect(message).not.toContain('may have executed');
  });

  it('preserves transport and cause details while requiring state verification before retry', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });

    const message = formatToolCallFailure('work_items:complete', error);

    expect(message).toContain('tools/call work_items:complete');
    expect(message).toContain('fetch failed');
    expect(message).toContain('UND_ERR_SOCKET: other side closed');
    expect(message).toContain('the tool call may have executed');
    expect(message).toContain('verify its state before retrying');
    expect(message).toContain('Do not blindly retry a mutation');
  });

  it('surfaces the idempotency receipt needed to replay an unknown outcome', () => {
    const error = Object.assign(new Error('Request timed out'), { code: -32001 });
    const message = formatToolCallFailure('work_items:checkpoint', error, {
      idempotencyKey: 'receipt-unknown-1',
    });

    expect(message).toContain('outcome=unknown');
    expect(message).toContain('idempotencyKey=receipt-unknown-1');
    expect(message).toContain('--idempotency-key receipt-unknown-1');
    expect(message).toContain('ptool transport flag');
    expect(message).toContain('MCP _meta.idempotencyKey');
    expect(message).toContain('not by adding idempotencyKey to the target tool JSON arguments');
  });

  it('does not mislabel a known pre-dispatch pressure shed as ambiguous', () => {
    const error = new Error('loop_pressure_critical');

    expect(isLoopPressureShed(error)).toBe(true);
    expect(formatToolCallFailure('coord:send', error)).toContain('rejected before dispatch');
    expect(formatToolCallFailure('coord:send', error)).toContain('no tool execution occurred');
    expect(formatToolCallFailure('coord:send', error)).not.toContain('may have executed');
  });

  it('classifies every typed proxy queue refusal as pre-dispatch, including coord:send dwell', () => {
    const proxySheds = [
      'mcp_proxy_overloaded',
      'mcp_proxy_handshake_overloaded',
      'mcp_proxy_handshake_queue_dwell',
      'mcp_proxy_coord_send_queue_full',
      'mcp_proxy_coord_send_queue_dwell',
      'mcp_proxy_critical_continuation_queue_full',
      'mcp_proxy_critical_continuation_queue_dwell',
    ].map((error) => Object.assign(new Error(
      `Streamable HTTP error: Error POSTing to endpoint: {"error":"${error}","retryable":true,"retryAfterSec":1}`,
    ), { code: 429 }));
    const providerLimit = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"provider_rate_limit"}',
    ), { code: 429 });
    const realProxy502 = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_error"}',
    ), { code: 502 });

    for (const proxyShed of proxySheds) {
      expect(isLoopPressureShed(proxyShed)).toBe(true);
      expect(formatToolCallFailure('coord:send', proxyShed)).toContain(
        'rejected before dispatch',
      );
      expect(formatToolCallFailure('coord:send', proxyShed)).toContain(
        'no tool execution occurred',
      );
    }
    expect(isLoopPressureShed(providerLimit)).toBe(false);
    expect(isLoopPressureShed(realProxy502)).toBe(false);
  });

  it('retries a typed proxy refusal using its Retry-After hint', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const proxyShed = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_critical_continuation_queue_full","retryable":true,"retryAfterSec":2}',
    ), { code: 429 });
    const callTool = vi.fn().mockRejectedValueOnce(proxyShed).mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry(
      { callTool },
      { name: 'tools:invoke', arguments: { name: 'work_items:checkpoint', args: {} } },
      { maxAttempts: 2, sleep },
    )).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('retries a coord:send queue-dwell refusal using its Retry-After hint', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const proxyShed = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_coord_send_queue_dwell","retryable":true,"forwardingResult":"not_forwarded","retryAfterSec":2}',
    ), { code: 429 });
    const callTool = vi.fn().mockRejectedValueOnce(proxyShed).mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry(
      { callTool },
      { name: 'tools:invoke', arguments: { name: 'coord:send', args: {} } },
      { maxAttempts: 2, sleep },
    )).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});

describe('ptool keyed result recovery without concurrent replay', () => {
  it('allows replay only for an explicitly read-only listed tool', () => {
    expect(isReadOnlyTool({ name: 'work_items:get', annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadOnlyTool({ name: 'work_items:complete', annotations: { readOnlyHint: false } })).toBe(false);
    expect(isReadOnlyTool({ name: 'work_items:get' })).toBe(false);
  });

  it('puts one caller-supplied idempotency key beside the format metadata', () => {
    expect(buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    })).toEqual({
      name: 'work_items:complete',
      arguments: { id: 'EI-1' },
      _meta: { format: 'json', idempotencyKey: 'ptool-key-1' },
    });
  });

  it('negotiates projected object-schema calls as JSON instead of requesting the unprojected structured twin', () => {
    expect(buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' }, idempotencyKey: 'ptool-projected-1' },
    )).toEqual({
      name: 'sessions:read',
      arguments: { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      _meta: { format: 'json', idempotencyKey: 'ptool-projected-1' },
    });
  });

  it('uses schema-neutral MCP request validation for a projected call', async () => {
    const result = { content: [{ type: 'text', text: '{"turns":[{"turn_idx":1}]}' }] };
    const client = {
      callTool: vi.fn(),
      request: vi.fn().mockResolvedValue(result),
    };
    const params = buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' } },
    );

    await expect(callToolWithPressureRetry(client, params, {
      maxAttempts: 1,
      timeoutMs: 1,
    })).resolves.toBe(result);

    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toEqual({ method: 'tools/call', params });
    expect(client.request.mock.calls[0][2]).toEqual({ timeout: 1, maxTotalTimeout: 1 });
  });

  it('recognizes MCP stream-close/deadline failures but not tool errors', () => {
    expect(isTransportFailure(Object.assign(new Error('Connection closed'), { code: -32000 }))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error('Request timed out'), { code: -32001 }))).toBe(true);
    expect(isTransportFailure(new Error('MCP error -32602: invalid arguments'))).toBe(false);
    expect(isTransportFailure(new Error('tool failed after dispatch'))).toBe(false);
  });

  it('does not reconnect after a post-connect close while the original may still be running', async () => {
    const params = buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    });
    const failure = Object.assign(new Error('Connection closed'), { code: -32000 });
    const first = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn(),
    };
    const reconnect = vi.fn();

    await expect(callToolWithReplayRecovery(first, params, {
      reconnect,
      timeoutMs: 1,
    })).rejects.toBe(failure);

    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('reconnects and replays one time after a post-connect close for a read-only tool', async () => {
    const params = buildCallToolParams('work_items:get', { id: 'WI-41554' }, {
      idempotencyKey: 'ptool-read-key-1',
    });
    const failure = Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' });
    const first = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      close: vi.fn(),
    };
    const reconnect = vi.fn().mockResolvedValue(second);

    const recovered = await callToolWithReplayRecovery(first, params, {
      reconnect,
      readOnly: true,
      timeoutMs: 1,
    });

    expect(PTOOL_READ_ONLY_POST_CONNECT_RETRIES).toBe(1);
    expect(recovered).toEqual({ client: second, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(second.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('cannot re-enable automatic replay with a larger per-call retry budget', async () => {
    const firstError = Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' });
    const first = { callTool: vi.fn().mockRejectedValue(firstError), close: vi.fn() };
    const reconnect = vi.fn();
    const params = buildCallToolParams('coord:send', {}, { idempotencyKey: 'ptool-key-2' });

    await expect(callToolWithReplayRecovery(first, params, { reconnect, maxAttempts: 99 })).rejects.toBe(firstError);
    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
  });
});

describe('ptool result formatting', () => {
  it('prints structuredContent when the MCP response has no content blocks', async () => {
    expect(resultToText({ structuredContent: { ok: true, value: 7 } }))
      .toBe('{"ok":true,"value":7}');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ structuredContent: { ok: true } }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('prefers complete structuredContent over lossy text content', () => {
    expect(resultToText({
      content: [{ type: 'text', text: '{"items":[\n[result-door: truncated]' }],
      structuredContent: { items: [{ id: 'P-001' }] },
    })).toBe('{"items":[{"id":"P-001"}]}');
  });

  it('fails loudly instead of emitting a result-door-truncated JSON prefix', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = {
        content: [{
          type: 'text',
          text: '{"items":[{"id":"P-001"},\n[result-door: this result exceeded the token budget and was truncated.',
        }],
      };
      expect(await printResult(result, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(PTOOL_TRUNCATED_RESULT_MESSAGE);
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('may have executed');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('verify its state before retrying');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('narrow the query');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('jq');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('keeps appended advisory content off raw stdout so jq can parse the payload', async () => {
    const result = {
      content: [
        { type: 'text', text: '{"ok":true,"value":7}' },
        { type: 'text', text: 'See also: loop:arm (start a loop)' },
      ],
    };

    expect(resultToText(result, { raw: true })).toBe('{"ok":true,"value":7}');
    expect(resultToText(result, { raw: false })).toBe(
      '{"ok":true,"value":7}\nSee also: loop:arm (start a loop)',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult(result, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true,"value":7}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('fails loudly instead of exiting zero with blank stdout for an empty response', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ content: [] }, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'ptool: operator returned an empty MCP result; no content or structuredContent was received',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('escapes raw controls inside JSON text for jq-safe raw output', async () => {
    const nul = String.fromCharCode(0);
    const raw = `{"message":"before${nul}after\nline"}`;
    const repaired = sanitizeJsonText(raw);

    expect(JSON.parse(repaired)).toEqual({ message: `before${nul}after\nline` });
    expect(repaired).toContain('\\u0000');
    expect(repaired).toContain('\\u000a');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ content: [{ type: 'text', text: raw }] }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith(repaired);
      expect(await printResult({ content: [{ type: 'text', text: raw }] }, { raw: false })).toBe(0);
      expect(log).toHaveBeenLastCalledWith(JSON.stringify(JSON.parse(repaired), null, 2));
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('leaves non-JSON text unchanged', () => {
    const text = `plain${String.fromCharCode(0)}text`;
    expect(sanitizeJsonText(text)).toBe(text);
  });

  it('repairs a truncated JSON prefix without requiring a valid whole document', () => {
    const truncated = '{"message":"first\nsecond';
    expect(sanitizeJsonText(truncated)).toBe('{"message":"first\\u000asecond');
  });
});

describe('ptool --json output-envelope unwrap (EI-22212780570913684)', () => {
  it('is a no-op on a plain result (same reference)', async () => {
    const result = { ok: true, value: 7 };
    expect(await unwrapOutputEnvelope(result)).toBe(result);
  });

  it('is a no-op on a result that happens to carry its own content array + ok', async () => {
    const result = { ok: true, content: [{ type: 'text', text: 'hi' }] };
    expect(await unwrapOutputEnvelope(result)).toBe(result);
  });

  it('unwraps an INLINE envelope (no spill) to the real tool result', async () => {
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [
        { type: 'text', text: '{"ok":true,"lock_id":"94ed8996-abc"}' },
        { type: 'text', text: 'See also: locks:release' },
      ],
    };
    expect(await unwrapOutputEnvelope(envelope)).toEqual({ ok: true, lock_id: '94ed8996-abc' });
  });

  it('unwraps a SPILLED envelope by reading the referenced file, scanning for the parseable part (never trusting position)', async () => {
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [{
        kind: 'reference',
        uri: 'papercusp://scratch/papercusp-workspace/locks:acquire/5084d585-0000-4000-8000-000000000000/result-door-123.spill',
        preview: '{"ok":true,"lock_id":"94ed8996-...',
      }],
    };
    // NOT index 0 — proves the unwrap scans instead of trusting position, same
    // as the "See also:" advisory text landing before the payload in practice.
    const spilledPayload = {
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: '{"ok":true,"lock_id":"94ed8996-full-id"}' },
      ],
    };
    const readSpill = vi.fn().mockResolvedValue(spilledPayload);
    const fileExists = vi.fn().mockReturnValue(true);
    expect(await unwrapOutputEnvelope(envelope, { readSpill, fileExists })).toEqual({
      ok: true,
      lock_id: '94ed8996-full-id',
    });
    expect(readSpill).toHaveBeenCalledWith(
      expect.stringContaining('locks:acquire/5084d585-0000-4000-8000-000000000000/result-door-123.spill'),
    );
  });

  it('returns the envelope UNCHANGED — never a fabricated success — when the reference cannot be read or parsed', async () => {
    const missing = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: 'papercusp://scratch/ws/tool/00000000-0000-4000-8000-000000000000/gone.spill' }],
    };
    expect(await unwrapOutputEnvelope(missing, { fileExists: () => false })).toBe(missing);

    const unreadable = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: 'papercusp://scratch/ws/tool/00000000-0000-4000-8000-000000000000/bad.spill' }],
    };
    expect(
      await unwrapOutputEnvelope(unreadable, {
        fileExists: () => true,
        readSpill: vi.fn().mockRejectedValue(new Error('disk error')),
      }),
    ).toBe(unreadable);
  });

  it('scratchUriToPath rejects a non-matching scheme and any traversal attempt', () => {
    expect(scratchUriToPath('not-a-scratch-uri')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/../../etc/passwd')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/ws/tool/run/../../../etc/passwd')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/')).toBe('');
  });

  it('scratchUriToPath maps a valid URI under the resolved (overridable) scratch root', () => {
    const env = { PAPERCUSP_SCRATCH_ROOT: '/tmp/fake-scratch-root' };
    expect(scratchUriToPath('papercusp://scratch/ws/tool:verb/run-id/file.spill', env)).toBe(
      '/tmp/fake-scratch-root/ws/tool:verb/run-id/file.spill',
    );
  });

  it('printResult (raw mode) prints the UNWRAPPED result, not the envelope — the exact EI-22212780570913684 shape', async () => {
    const grantedLockEnvelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [{ type: 'text', text: '{"ok":true,"lock_id":"94ed8996-abc"}' }],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await printResult(
        { content: [{ type: 'text', text: JSON.stringify(grantedLockEnvelope) }] },
        { raw: true },
      );
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true,"lock_id":"94ed8996-abc"}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('ptool scripted JSON output', () => {
  it('uses the raw JSON extractor for every explicit JSON input, without requiring --raw', () => {
    expect(shouldPrintRawResult('inline', false)).toBe(true);
    expect(shouldPrintRawResult('file', false)).toBe(true);
    expect(shouldPrintRawResult('stdin', false)).toBe(true);
    expect(shouldPrintRawResult(null, false)).toBe(false);
    expect(shouldPrintRawResult(null, true)).toBe(true);
  });
});

describe('stdout delivery failure (EI-21250765620092599)', () => {
  // Node swallows EPIPE on process.stdout: when the consumer of a piped/captured
  // stdout dies, later writes are dropped silently and the process exits 0 — the
  // "completed successfully but emitted no JSON or text" wake-harness shape.
  // printResult must convert a detected delivery failure into stderr + exit 1.
  it('fails loudly when stdout delivery errored after the write (swallowed EPIPE)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await printResult(
        { structuredContent: { ok: true } },
        { raw: true, deliveryProbe: () => Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) },
      );
      expect(code).toBe(1);
      expect(log).toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('stdout delivery FAILED (EPIPE)');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('reports success with no stderr on a healthy stream, and the live probe is quiet', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ structuredContent: { ok: true } }, { raw: true })).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(stdoutDeliveryError()).toBeNull();
  });
});

describe('ptool JSON input', () => {
  it('treats empty stdin as an empty args object for zero-argument tools (EI-21579932287582806)', () => {
    expect(parseJsonInput('', { emptyAsObject: true })).toEqual({});
    expect(parseJsonInput('  \n\t', { emptyAsObject: true })).toEqual({});
  });

  it('keeps empty inline and file payloads strict', () => {
    expect(() => parseJsonInput('')).toThrow();
    expect(() => parseJsonInput('  \n\t')).toThrow();
  });

  it('accepts literal newlines inside quoted values from a heredoc payload', () => {
    const payload = [
      '{',
      '  "slug": "validation-plan",',
      '  "body": "first line',
      'second line",',
      '  "nested": { "value": "already\\nescaped" }',
      '}',
    ].join('\n');

    expect(parseJsonInput(payload)).toEqual({
      slug: 'validation-plan',
      body: 'first line\nsecond line',
      nested: { value: 'already\nescaped' },
    });
    expect(escapeJsonStringControls(payload)).toContain('first line\\u000asecond line');
  });

  it('leaves formatting whitespace outside strings and already-escaped controls unchanged', () => {
    const payload = '{\n  "body": "first\\nsecond"\n}\n';
    expect(escapeJsonStringControls(payload)).toBe(payload);
    expect(parseJsonInput(payload)).toEqual({ body: 'first\nsecond' });
  });
});

describe('ptool local-connect retry diagnostics (EI-21504867146958629)', () => {
  const shedErr = () =>
    Object.assign(new Error('{"error":"mcp_proxy_handshake_overloaded","retryAfterSec":2}'), { code: 429 });

  it('honors Retry-After as a minimum and adds positive jitter', async () => {
    const sleeps: number[] = [];
    await expect(
      connectWithLocalRetry(
        async () => {
          throw shedErr();
        },
        'http://127.0.0.1:3070',
        {},
        {
          maxAttempts: 3,
          attemptTimeoutMs: 5_000,
          totalTimeoutMs: 60_000,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
          rand: () => 0,
        },
      ),
    ).rejects.toThrow(/proxy-shed-429/);
    // A zero entropy sample still produces one positive millisecond: clients
    // never retry before the server minimum and never share the exact boundary.
    expect(sleeps).toEqual([2_001, 2_001]);
  });

  it('de-synchronizes independent ptool processes given the same Retry-After hint', async () => {
    const samples = [0.1, 0.5, 0.9];
    const waits = await Promise.all(samples.map(async (sample) => {
      const sleeps: number[] = [];
      await expect(
        connectWithLocalRetry(
          async () => {
            throw shedErr();
          },
          'http://127.0.0.1:9071',
          {},
          {
            maxAttempts: 2,
            attemptTimeoutMs: 5_000,
            totalTimeoutMs: 60_000,
            rand: () => sample,
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
          },
        ),
      ).rejects.toThrow(/proxy-shed-429/);
      return sleeps[0];
    }));

    expect(waits).toEqual([2_100, 2_500, 2_900]);
    expect(new Set(waits).size).toBe(samples.length);
    expect(waits.every((wait) => wait > 2_000)).toBe(true);
  });

  it('applies the same positive jitter to tools/list discovery retries', async () => {
    const listTools = vi.fn().mockRejectedValue(shedErr());
    const sleeps: number[] = [];

    await expect(
      listToolsWithLocalRetry(
        { listTools },
        {},
        {
          maxAttempts: 2,
          timeoutMs: 5_000,
          totalTimeoutMs: 60_000,
          rand: () => 0.4,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow(/mcp_proxy_handshake_overloaded/);

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_400]);
  });

  it('does not retry before a server minimum that exhausts the remaining budget', () => {
    expect(PTOOL_RETRY_JITTER_MS).toBe(1_000);
    expect(retryWaitMsWithJitter(2_000, 2_000, { rand: () => 1 })).toBeNull();
    expect(retryWaitMsWithJitter(2_000, 2_500, { rand: () => 1 })).toBe(2_500);
  });

  it('an exhausted budget escapes with the original prefix AND the classified attempt tally', async () => {
    const hang = (): Promise<never> => Promise.withResolvers<never>().promise;
    let calls = 0;
    await expect(
      connectWithLocalRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw shedErr();
          return hang();
        },
        'http://127.0.0.1:3070',
        {},
        {
          maxAttempts: 3,
          attemptTimeoutMs: 20,
          totalTimeoutMs: 60_000,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(
      /^local operator connection attempt timed out after 20ms \[3 connect attempt\(s\) over \d+s: 1x proxy-shed-429, 2x attempt-timeout\]$/,
    );
  });

  it('caps repeated proxy-upstream 502 handshakes after one ptool replay', async () => {
    const proxyError = Object.assign(new Error('mcp_proxy_upstream_error'), { code: 502 });
    const connectOnce = vi.fn().mockRejectedValue(proxyError);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, {
        maxAttempts: 20,
        attemptTimeoutMs: 5_000,
        totalTimeoutMs: 60_000,
        sleep,
      }),
    ).rejects.toBe(proxyError);

    expect(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS).toBe(2);
    expect(connectOnce).toHaveBeenCalledTimes(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(proxyError.message).toMatch(
      /\[2 connect attempt\(s\) over \d+s: 2x proxy-upstream-502\]$/,
    );
  });
});

describe('ptool SDK import install-race tolerance (EI-21860372620642128)', () => {
  const moduleNotFound = (specifier: string) =>
    Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });

  it('returns the imported module on a clean first attempt without consulting the mutex', async () => {
    const doImport = vi.fn().mockResolvedValue({ Client: 'ok' });
    const loadInstallMutex = vi.fn();
    const result = await importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', {
      doImport,
      loadInstallMutex,
      sleep: vi.fn(),
    });
    expect(result).toEqual({ Client: 'ok' });
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(loadInstallMutex).not.toHaveBeenCalled();
  });

  it('rethrows a non-MODULE_NOT_FOUND failure immediately, without consulting the mutex', async () => {
    const otherError = new TypeError('boom');
    const doImport = vi.fn().mockRejectedValue(otherError);
    const loadInstallMutex = vi.fn();
    await expect(
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/types.js', { doImport, loadInstallMutex }),
    ).rejects.toBe(otherError);
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(loadInstallMutex).not.toHaveBeenCalled();
  });

  it('rethrows MODULE_NOT_FOUND immediately when no install:safe write is in flight (genuine missing dep)', async () => {
    const notFound = moduleNotFound('@modelcontextprotocol/sdk/types.js');
    const doImport = vi.fn().mockRejectedValue(notFound);
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { peekFsMutexSync: () => ({ held: false }) },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    const sleep = vi.fn();
    await expect(
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/types.js', { doImport, loadInstallMutex, sleep }),
    ).rejects.toBe(notFound);
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rethrows MODULE_NOT_FOUND immediately when the mutex helper itself cannot be loaded', async () => {
    const notFound = moduleNotFound('@modelcontextprotocol/sdk/client/index.js');
    const doImport = vi.fn().mockRejectedValue(notFound);
    const loadInstallMutex = vi.fn().mockRejectedValue(new Error('cannot resolve helper'));
    await expect(
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', { doImport, loadInstallMutex }),
    ).rejects.toBe(notFound);
    expect(doImport).toHaveBeenCalledTimes(1);
  });

  it('waits out a live install:safe write and returns the module once the retry succeeds', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notFound = moduleNotFound('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const doImport = vi.fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ StreamableHTTPClientTransport: 'ok' });
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { peekFsMutexSync: () => ({ held: true, owner: { pid: 4242, host: 'devbox' } }) },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    const sleeps: number[] = [];
    const result = await importSdkModuleWithInstallAwareness(
      '@modelcontextprotocol/sdk/client/streamableHttp.js',
      {
        doImport,
        loadInstallMutex,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        totalMs: 10_000,
        intervalMs: 1_500,
      },
    );
    expect(result).toEqual({ StreamableHTTPClientTransport: 'ok' });
    expect(doImport).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1_500, 1_500]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('gives up and rethrows the original MODULE_NOT_FOUND once the retry budget is exhausted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notFound = moduleNotFound('@modelcontextprotocol/sdk/client/index.js');
    const doImport = vi.fn().mockRejectedValue(notFound);
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { peekFsMutexSync: () => ({ held: true, owner: { pid: 4242 } }) },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', {
          doImport,
          loadInstallMutex,
          sleep,
          totalMs: 5_000,
          intervalMs: 2_000,
        }),
      ).rejects.toBe(notFound);
    } finally {
      Date.now = originalNow;
      consoleError.mockRestore();
    }
    // Bounded: stops retrying once elapsed time reaches the budget rather than looping forever.
    expect(doImport.mock.calls.length).toBeGreaterThan(1);
    expect(doImport.mock.calls.length).toBeLessThan(10);
  });
});
