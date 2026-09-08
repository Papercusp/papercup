/**
 * The startup guards must actually be CALLED at boot (EI-10660).
 *
 * This test exists because of a specific, embarrassing failure: `validateActiveRoutines` was
 * written as an EI-2224 recurrence guard, given four passing unit tests, and documented with a
 * "Called by:" block naming two callers — and it had ZERO callers for its entire life. Every
 * test was green. The logic was correct. The verdict went nowhere.
 *
 * A GREEN UNIT TEST PROVES A CHECK *WORKS*. IT NEVER PROVES THE CHECK *RUNS*.
 * Nothing in a per-module test suite can tell the difference between a wired guard and an
 * orphaned one — which is why that difference needs its own test, here, at the call site.
 *
 * Why assert against source text rather than invoking the boot path: `runBootstrap()` starts
 * background tickers that must never touch the shared/native DB from a unit test (the same
 * reason serve.test.ts refuses to boot it). Importing it to observe the calls would be worse
 * than the bug. So we assert the wiring the only way that is safe here — the boot file must
 * name each guard. Crude, but it fails loudly the moment someone deletes a call site, which is
 * exactly the regression that went unnoticed for months.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bootSrc = readFileSync(join(__dirname, 'host-bootstrap.ts'), 'utf8');
const dbosWorkItemsContractSrc = readFileSync(
  join(__dirname, '../../../packages/operator-core/lib/dbos/work-items-contract.ts'),
  'utf8',
);
const honoHostSrc = readFileSync(join(__dirname, 'hono-host.ts'), 'utf8');
const agentToolsCatchallSrc = readFileSync(
  join(__dirname, '../../../packages/operator-core/lib/endpoint-route/routes/agent-tools/catchall.ts'),
  'utf8',
);

/** Each guard, with the module it lives in — both must appear at the boot site. */
const STARTUP_GUARDS: Array<{ fn: string; module: string; catches: string }> = [
  {
    fn: 'validateHomeHarnessResolution',
    module: 'startup/validate-home-harness',
    catches: 'the HOME harness slug does not resolve — every fire-path 404s and goes dark',
  },
  {
    // EI-18678269428596559: the boot caller was intentionally switched from the bare
    // validateActiveRoutines() to enforceActiveRoutines() (which auto-PAUSES a violating
    // routine instead of just logging FATAL forever) — enforceActiveRoutines() itself calls
    // validateActiveRoutines(ws, { silent: true }) internally, so the guard stays wired, just
    // one hop deeper. Assert the actual boot-site call so this doesn't false-positive on that
    // refactor (host-bootstrap.startup-guards.test.ts flagged red 2026-07-26 on stale source
    // text after the rename).
    fn: 'enforceActiveRoutines',
    module: 'startup/validate-active-routines',
    catches: 'an ACTIVE routine targets an unregistered harness — it 404s and goes dark',
  },
  {
    fn: 'validateDeclaredSingletons',
    module: 'startup/validate-declared-singletons',
    catches: 'a DECLARED learning loop has no routine row — it never runs, and never will',
  },
  {
    // D-007 (silent-halt-detection-and-owner-rails-2026-08-08). This entry is the same bug as
    // the file header's, caught a second time in a second module: checkBespokeActiveSeeds had
    // five passing unit tests and ZERO callers outside its own manual CLI, for its entire life.
    // Its registry names `unguarded-halt-rescue` — the sweep that re-wakes silently-stopped
    // agents — which sat active=false for 11.9 days (measured 2026-08-08) while the other six
    // routines in that same registry fired normally. The check would have printed exactly one
    // name. Nothing ran it.
    fn: 'checkBespokeActiveSeeds',
    module: 'harness/routines/bespoke-active-seeds-check',
    catches:
      'an always-on routine (unguarded-halt-rescue, supervision-reconcile, …) is seeded but PAUSED — ' +
      'the two guards above both answer "fine" for a paused row, so nothing else asks whether the ' +
      'routines that must be RUNNING are running',
  },
  {
    fn: 'reconcileLegacyVoiceServices',
    module: 'voice-node/legacy-service-reconcile',
    catches:
      'a deleted VoiceMode Whisper entrypoint or stale compatibility unit can restart-loop beside the operator-owned local voice lifecycle',
  },
];

describe('host-bootstrap wires every startup guard', () => {
  for (const guard of STARTUP_GUARDS) {
    it(`calls ${guard.fn}() at boot — else: ${guard.catches}`, () => {
      expect(bootSrc).toContain(guard.module);
      // The call, not merely the import: an imported-but-uncalled guard is the EI-10660 bug.
      expect(bootSrc).toMatch(new RegExp(`${guard.fn}\\s*\\(`));
    });
  }

  it('keeps every guard fail-soft — a health check must never kill the boot', () => {
    // Each guard runs in its own try/catch IIFE. If a future edit lets one throw out of the
    // boot path, an unhandled rejection exits Node, embedded-PG goes down, and the app is dead
    // on launch (the BUG-1 failure the home-harness guard is already commented for).
    const catches = bootSrc.match(/catch\s*\(/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(STARTUP_GUARDS.length);
  });

  it('defers declared-singleton validation for any fresh operator host, including isolated Hono', () => {
    // The host starts before the async dogfood-hive bootstrap can register its first project.
    // This empty-workspace window exists for packaged desktop and isolated Hono hosts alike;
    // an env-specific desktop gate would leave the Hono path emitting a false FATAL. The
    // defer must stay narrow: established workspaces still call validateDeclaredSingletons().
    const singletonGuard = bootSrc.slice(
      bootSrc.indexOf("'@papercusp/operator-core/lib/startup/validate-declared-singletons'"),
      bootSrc.indexOf('// [D-007 startup validation]'),
    );
    expect(singletonGuard).toContain('if (await isLikelyFreshInstallGap())');
    expect(singletonGuard).not.toContain('PAPERCUSP_DESKTOP');
    expect(singletonGuard).toContain('[declared-singletons] startup validation deferred');
    expect(singletonGuard).toMatch(/startup validation deferred[\s\S]*?return;[\s\S]*?validateDeclaredSingletons\(\)/);
  });

  it('defers bespoke active-seed validation during a fresh packaged install', () => {
    // The same empty-workspace window applies to the always-on seed backstop: before the
    // first project exists, every bespoke seed row is absent by construction. Established
    // workspaces must still run the check so a genuinely missing/paused routine stays loud.
    expect(bootSrc).toMatch(
      /process\.env\.PAPERCUSP_DESKTOP\s*===\s*['"]1['"]\s*&&\s*\(await\s+isLikelyFreshInstallGap\(workspaceId\)\)/,
    );
    expect(bootSrc).toContain('[bespoke-active-seeds] startup validation deferred');
    expect(bootSrc).toMatch(
      /\[bespoke-active-seeds\]\s*startup validation deferred[\s\S]*?return;[\s\S]*?checkBespokeActiveSeeds\(/,
    );
  });

  // [EI-727] Not a STARTUP_GUARDS entry (it doesn't live in its own startup/validate-*
  // module — it's a one-line pure predicate on agent-config.ts) but the same
  // called-not-just-imported wiring risk applies: a silently-orphaned boot warning is as
  // useless as an orphaned guard.
  it('calls agentCmdBootWarning() at boot — else a host with no AGENT_CMD/CLAUDE silently falls back to the broken omp -p default', () => {
    expect(bootSrc).toContain('agentCmdBootWarning');
    expect(bootSrc).toMatch(/agentCmdBootWarning\s*\(/);
  });
});

describe('host-bootstrap fails the background plane closed on migration failure', () => {
  it('checks the boot-migration result before marking migrations applied or starting background machinery', () => {
    // Request-only hosts now run their own preflight in waitForBootMigrationGate().
    // Select the later background-host occurrence this describe is about.
    const apply = bootSrc.lastIndexOf('const migrationResult = await applyPendingMigrationsAtBoot()');
    const failureGuard = bootSrc.indexOf('if (!migrationResult || migrationResult.failed.length > 0)', apply);
    const withheld = bootSrc.indexOf('BACKGROUND STARTUP WITHHELD', failureGuard);
    const routingFailure = bootSrc.indexOf('markSubstrateBootRoutingFailed', failureGuard);
    const requestGate = bootSrc.indexOf('markMigrationsAppliedForRequestGate()', apply);
    const backgroundStartup = bootSrc.indexOf('provisionSystemPrincipals', requestGate);

    expect(apply).toBeGreaterThan(-1);
    expect(failureGuard).toBeGreaterThan(apply);
    expect(withheld).toBeGreaterThan(failureGuard);
    expect(routingFailure).toBeGreaterThan(withheld);
    expect(requestGate).toBeGreaterThan(withheld);
    expect(backgroundStartup).toBeGreaterThan(requestGate);

    const guardBody = bootSrc.slice(failureGuard, requestGate);
    expect(guardBody).toMatch(/BACKGROUND STARTUP WITHHELD[\s\S]*?return;/);
    expect(guardBody).toMatch(/markSubstrateBootRoutingFailed[\s\S]*?return;/);
  });
});

describe('background admission recovery loads the live kernel resolver before routines start', () => {
  const coreRoot = join(__dirname, '../../../packages/operator-core/lib');
  const coreSource = (path: string) => readFileSync(join(coreRoot, path), 'utf8');

  it('keeps the resolver install on the eager host-handler import graph, not the first MCP request', () => {
    // Do not import these modules: that would boot shared background work.
    // Pin each eager edge instead of merely finding the resolver name in a
    // test that installs it by hand. This also covers requestless primaries.
    const eagerEdges: Array<[string, RegExp]> = [
      [readFileSync(join(__dirname, 'host-handler.ts'), 'utf8'), /^import \{ app \} from '\.\/host-app';$/m],
      [readFileSync(join(__dirname, 'host-app.ts'), 'utf8'),
        /^import \{ registerRouteLiterals, registerRouteCatchalls \} from '@papercusp\/operator-core\/lib\/endpoint-route\/register';$/m],
      [coreSource('endpoint-route/register.ts'), /^import \{ ALL_ROUTES \} from '\.\/routes';$/m],
      [coreSource('endpoint-route/routes/index.ts'), /^import transport from '\.\/transport\/index';$/m],
      [coreSource('endpoint-route/routes/transport/index.ts'), /^import \{ mcpHandler \} from '\.\/_mcp-handler';$/m],
      [coreSource('endpoint-route/routes/transport/_mcp-handler.ts'), /^import '\.\.\/\.\.\/\.\.\/agent-tools\/index';$/m],
      [coreSource('agent-tools/index.ts'), /^import '\.\.\/events';$/m],
    ];
    for (const [source, edge] of eagerEdges) expect(source).toMatch(edge);
    expect(coreSource('events/index.ts')).toMatch(/^installControlAnchorKernelResolver\(\);$/m);
    expect(coreSource('projected-tool-deps.ts')).toMatch(
      /export function installControlAnchorKernelResolver\(\): void \{\s*setKernelEnforcementResolver\(controlAnchorKernelResolver\);/,
    );
  });

  it('evaluates the handler before bootstrap in both Hono and packaged background hosts', () => {
    expect(honoHostSrc).toMatch(/^import \{ handler \} from '\.\/host-handler';$/m);
    expect(honoHostSrc).toContain('return runBootstrap();');
    const packagedHost = readFileSync(join(__dirname, 'serve.ts'), 'utf8');
    const handlerImport = packagedHost.indexOf('const { handler } = await import("./host-handler");');
    const bootstrapCall = packagedHost.indexOf('runBootstrap();', handlerImport);
    expect(handlerImport).toBeGreaterThan(-1);
    expect(bootstrapCall).toBeGreaterThan(handlerImport);
    expect(packagedHost.slice(handlerImport, bootstrapCall)).toContain('requestHandler = handler;');
    expect(bootSrc).toMatch(
      /const \{ startDbos \} = await import\('@papercusp\/operator-core\/lib\/dbos\/bootstrap'\);\s*await startDbos\(\);/,
    );
    for (const path of ['dbos/routines-workflow.ts', 'dbos/ephemeral-executor.ts']) {
      expect(coreSource(path)).toMatch(/^import '\.\.\/harness\/routines\/register-system-actions';$/m);
    }
  });
});

describe('request-only hosts apply migrations before opening HTTP', () => {
  it('runs the coordinated boot preflight and marks the request gate only after a clean result', () => {
    const requestOnly = bootSrc.indexOf(
      'if (!backgroundWorkersEnabled()) {\n    const { applyPendingMigrationsAtBoot }',
    );
    const apply = bootSrc.indexOf('const migrationResult = await applyPendingMigrationsAtBoot()', requestOnly);
    const failure = bootSrc.indexOf('request-only migration preflight failed', apply);
    const requestGate = bootSrc.indexOf('markMigrationsAppliedForRequestGate()', apply);

    expect(requestOnly).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(requestOnly);
    expect(failure).toBeGreaterThan(apply);
    expect(requestGate).toBeGreaterThan(failure);
    expect(bootSrc.slice(requestOnly, requestGate)).toMatch(
      /if\s*\(!migrationResult\s*\|\|\s*migrationResult\.failed\.length\s*>\s*0\)[\s\S]*?throw new Error\(/,
    );
  });

  it('fails closed when the request migration preflight rejects instead of serving anyway', () => {
    const wait = honoHostSrc.indexOf('void waitForBootMigrationGate().then(() => {');
    const start = honoHostSrc.indexOf('startRequestServers();', wait);
    const failure = honoHostSrc.indexOf('request-serving startup withheld:', wait);
    const exit = honoHostSrc.indexOf('process.exit(1);', failure);

    expect(wait).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(wait);
    expect(failure).toBeGreaterThan(start);
    expect(exit).toBeGreaterThan(failure);
    expect(honoHostSrc.slice(wait, exit)).toMatch(/\}\)\.catch\(\(e\)\s*=>\s*\{/);
  });
});

describe('host-bootstrap arms the engine-death sentinel only on a DBOS-owning host', () => {
  it('uses the same dbosLaunchesHere() predicate as the DBOS launch gate', () => {
    const start = bootSrc.indexOf('// Red Queen engine-death sentinel');
    const end = bootSrc.indexOf('// EI-1622:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const sentinelSection = bootSrc.slice(start, end);
    expect(sentinelSection).toContain('if (dbosLaunchesHere())');
    expect(sentinelSection).toMatch(/dbosLaunchesHere\(\)[\s\S]*armEngineDeathSentinel\(\)/);
    expect(sentinelSection).not.toMatch(/if\s*\(\s*backgroundWorkers\s*\)/);
  });
});

describe('hono-host wires request-worker allocation sampling', () => {
  it('keeps the non-blocking heap sampler enabled with an RSS trigger independent of full snapshots', () => {
    const monitorCall = honoHostSrc.match(/startEventLoopLagMonitor\s*\(\s*\{[\s\S]*?\}\s*\)/)?.[0] ?? '';
    expect(monitorCall).toContain('heapSamplingOnHighRss: true');
    expect(monitorCall).toContain('heapSamplingRssMb:');
    expect(monitorCall).toContain('PAPERCUSP_HEAP_SNAPSHOT_RSS_MB');
    expect(monitorCall).not.toContain('heapSnapshotOnHighRss: true');
  });
});

describe('hono-host absorbs a dead stdio peer before process-level fault handling', () => {
  it('installs the shared stdio guard at module scope before diagnostics and exception handlers', () => {
    // WI-41422: desktop-dev/background task supervision enters hono-host.ts
    // directly, so serve.ts's otherwise-correct guard never runs. When the
    // supervisor-side stdout/stderr socket disappears, console.warn inside the
    // uncaughtException handler recursively raises another EPIPE and burns the
    // main thread. The guard's behavioural tests prove that it absorbs the
    // stream error; this assertion proves THIS entrypoint actually installs it.
    const guardImport = honoHostSrc.indexOf(
      "@papercusp/operator-core/lib/process-supervision/stdio-peer-guard",
    );
    const guardCall = honoHostSrc.indexOf('\ninstallStdioPeerGuard();');
    const fatalDiagnostics = honoHostSrc.indexOf('\ninstallFatalDiagnostics();');
    const unhandledRejection = honoHostSrc.indexOf("process.on('unhandledRejection'");
    const uncaughtException = honoHostSrc.indexOf("process.on('uncaughtException'");

    expect(guardImport).toBeGreaterThan(-1);
    expect(guardCall).toBeGreaterThan(guardImport);
    expect(guardCall).toBeLessThan(fatalDiagnostics);
    expect(guardCall).toBeLessThan(unhandledRejection);
    expect(guardCall).toBeLessThan(uncaughtException);
  });
});

describe('hono-host exposes a no-native-teardown desktop-dev recycle contract', () => {
  it('handles Linux desktop-dev SIGUSR2 with a bounded hard-exit recycle before listening', () => {
    // WI-41422: process.exit(75) reached native addon teardown and aborted with
    // exit 134. The wrapper restarts after every child-only exit, so the
    // entrypoint must drain and then use the no-teardown hard-exit path. The
    // handler must exist before :3270 accepts a request.
    const handler = honoHostSrc.indexOf("process.on('SIGUSR2'");
    const listen = honoHostSrc.indexOf('listenWithEaddrinuseRetry(');
    const marker = honoHostSrc.indexOf("process.env.DBOS__VMID === `desktop-dev-${port}`");
    const exitCode = honoHostSrc.indexOf('recycleExitCode: 75', handler);
    const hardExit = honoHostSrc.indexOf('hardExitOnRecycle: true', handler);

    expect(marker).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(marker);
    expect(exitCode).toBeGreaterThan(handler);
    expect(hardExit).toBeGreaterThan(handler);
    expect(handler).toBeLessThan(listen);
  });
});

describe('hono-host arms remote authorization before listening', () => {
  it('calls assertRemoteAuthReady(hostname) before any request server can bind', () => {
    const guard = honoHostSrc.indexOf(
      'const remoteAuthPolicy = assertRemoteAuthReady(hostname);',
    );
    const requestServer = honoHostSrc.indexOf('function startRequestServers(): void');
    const listen = honoHostSrc.indexOf('listenWithEaddrinuseRetry(', requestServer);

    expect(guard).toBeGreaterThan(-1);
    expect(requestServer).toBeGreaterThan(guard);
    expect(listen).toBeGreaterThan(requestServer);
  });
});

describe('host-bootstrap emits a machine-readable source-pass verdict', () => {
  it('calls the stable PASS2_RESULT formatter for ran, skipped, and failed outcomes', () => {
    expect(bootSrc).toContain('formatEnvOperatorPass2Result');
    expect(bootSrc.match(/formatEnvOperatorPass2Result\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(bootSrc).toMatch(/status:\s*'ran'/);
    expect(bootSrc).toMatch(/status:\s*'skipped'/);
    expect(bootSrc).toMatch(/status:\s*'failed'/);
  });
});

describe('host-bootstrap keeps vm-release single-operator', () => {
  it('gates environment-operator provisioning on the immutable distribution profile', () => {
    expect(bootSrc).toContain('isVmReleaseDistribution');
    expect(bootSrc).toMatch(
      /!isVmReleaseDistribution\(\)[\s\S]*?PAPERCUSP_DESKTOP[\s\S]*?PAPERCUSP_PROVISION_ENV_OPERATORS/,
    );
  });
});

describe('host-bootstrap validates the bundled DBOS work-items import contract', () => {
  it('uses the sidecar build marker and checks the current exclusion export before startDbos()', () => {
    expect(bootSrc).toContain('__PAPERCUSP_BUNDLED_SIDECAR__');
    expect(bootSrc).toContain('assertDbosWorkItemsImportContract');
    expect(bootSrc).toContain('import(\'@papercusp/operator-core/lib/work-items\')');
    // The boot site delegates the export list to the dependency-free contract helper;
    // assert the names where that list is authored instead of coupling this wiring test
    // to implementation details inside host-bootstrap.
    expect(dbosWorkItemsContractSrc).toContain('needsOwnerActionExclusionSql');

    const contractCheck = bootSrc.indexOf('assertDbosWorkItemsImportContract(workItems)');
    const dbosImport = bootSrc.indexOf("const { startDbos } = await import('@papercusp/operator-core/lib/dbos/bootstrap')");
    expect(contractCheck).toBeGreaterThan(-1);
    expect(dbosImport).toBeGreaterThan(contractCheck);
  });
});

describe('host-bootstrap keeps one owner for the endpoint IPC tool registry', () => {
  it('does not re-import the agent-tools barrel through a second module specifier', () => {
    expect(bootSrc).not.toContain("import('@papercusp/operator-core/lib/agent-tools')");
    expect(bootSrc).toContain('listAllProjectedTools()');
  });

  it('keeps the endpoint route graph as the registry side-effect owner', () => {
    expect(agentToolsCatchallSrc).toContain("import '../../../agent-tools/index';");
  });
});

describe('host-bootstrap owns the packaged MCP proxy child lifecycle (EI-21106306876206131)', () => {
  const lifecycleSrc = (() => {
    const start = bootSrc.indexOf('const PACKAGED_MCP_PROXY_SHUTDOWN_TIMEOUT_MS');
    const end = bootSrc.indexOf('\n/**', start);
    return bootSrc.slice(start, end > start ? end : undefined);
  })();

  it('tracks a non-detached child and registers a bounded graceful shutdown hook', () => {
    // The child handle must live in state that survives a MODULE SPLIT, not a
    // plain module-local. Both forms "track the child" on a single record, so
    // the original `let packagedMcpProxyProcess` assertion could not tell them
    // apart — but on a split the run-once guard stops the second record from
    // bootstrapping, so whichever record spawned the child owns the only handle
    // to it while `stopPackagedMcpProxy` can be reached on the OTHER record,
    // see null, and orphan the proxy on :9071 with no error on any path.
    // Asserted against bootSrc, not lifecycleSrc: the pin is declared above the
    // slice window on purpose (see the comment on the timeout const).
    expect(bootSrc).toContain("pinModuleState<{");
    expect(bootSrc).toContain("'@papercusp/web.host-bootstrap'");
    expect(bootSrc).toContain('packagedMcpProxyProcess: ChildProcess | null;');
    expect(bootSrc).not.toContain('let packagedMcpProxyProcess');
    expect(lifecycleSrc).toContain('registerSidecarShutdownHooks({');
    expect(lifecycleSrc).toContain("label: 'packaged-mcp-proxy'");
    expect(lifecycleSrc).toContain("mode: 'async-with-exit'");
    expect(lifecycleSrc).toContain('gracefulStopChild(child');
    expect(lifecycleSrc).toContain('PACKAGED_MCP_PROXY_SHUTDOWN_TIMEOUT_MS');
    expect(lifecycleSrc).toContain('detached: false');
    expect(lifecycleSrc).toContain('packagedMcpProxyProcess = child');
    expect(lifecycleSrc).toContain("child.once('exit'");
    expect(lifecycleSrc).toContain('await beginGovernedExecution(');
    expect(lifecycleSrc).toContain("admissionClass: 'mcp'");
    expect(lifecycleSrc).toContain('PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context)');
    expect(lifecycleSrc).toContain('void execution.finish()');
    expect(lifecycleSrc).toContain('void execution.cancel(e.message)');
    expect(lifecycleSrc).toContain("mode: hasPackagedEntry ? 'packaged-child' : 'in-process-fallback'");
    expect(lifecycleSrc).toContain("server.once('close', () => void execution.finish())");
    expect(lifecycleSrc).toContain('await execution.cancel((e as Error)?.message ?? String(e))');
    expect(lifecycleSrc).not.toContain('child.unref()');
  });

  it('does not spawn after shutdown wins the asynchronous health-probe race', () => {
    expect(lifecycleSrc).toContain('packagedMcpProxyShutdownRequested = true');
    expect(
      lifecycleSrc.match(/if\s*\(\s*BOOTSTRAP_STATE\.packagedMcpProxyShutdownRequested\s*\)/g) ?? [],
    ).toHaveLength(4);
  });
});

/**
 * EI-19305266463631270 — per-HOST singletons must be started under `cluster.isPrimary`.
 *
 * The bug this pins: three per-host singletons are started within ~40 lines of each other in
 * host-bootstrap, and exactly one of them (ensureHarnessStatusSweep) was missing the
 * `cluster.isPrimary` wrapper its two neighbours had. It instead leaned on its own internal
 * `backgroundWorkersEnabled()` stand-down — the very predicate the comment beside the
 * fs-watcher already explains cannot express "once per host", because the dev-api drop-in sets
 * PAPERCUSP_BACKGROUND_WORKERS=0 service-wide. Result: on the 16-worker :3070 release cluster
 * the predicate read false in all 17 processes, none stood down, and all 17 armed a 30s
 * PID-liveness sweep (plus a 17-way thundering herd on every deploy, since it also ticks
 * immediately at boot).
 *
 * Why a source assertion rather than invoking the boot path: same reason as the suite above —
 * runBootstrap() starts background tickers that must not touch the shared DB from a unit test.
 *
 * This does real brace-matching rather than a proximity regex, so it cannot be satisfied by an
 * `if (cluster.isPrimary)` that merely appears somewhere earlier in the file.
 */
describe('host-bootstrap starts per-host singletons under cluster.isPrimary', () => {
  /** Blank out comments so braces inside them never affect depth, WITHOUT shifting indices. */
  const masked = (() => {
    let out = bootSrc.split('');
    let i = 0;
    while (i < out.length) {
      const two = bootSrc[i] + bootSrc[i + 1];
      if (two === '//') {
        while (i < out.length && out[i] !== '\n') out[i++] = ' ';
      } else if (two === '/*') {
        while (i < out.length && !(bootSrc[i - 1] === '*' && bootSrc[i] === '/')) out[i++] = ' ';
        if (i < out.length) out[i++] = ' ';
      } else i++;
    }
    return out.join('');
  })();

  /** [start,end) spans of every `if (cluster.isPrimary) { ... }` block body. */
  const primarySpans: Array<[number, number]> = (() => {
    const spans: Array<[number, number]> = [];
    const re = /if\s*\(\s*cluster\.isPrimary\s*\)\s*\{/g;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
      let depth = 1;
      let j = m.index + m[0].length;
      for (; j < masked.length && depth > 0; j++) {
        if (masked[j] === '{') depth++;
        else if (masked[j] === '}') depth--;
      }
      spans.push([m.index, j]);
    }
    return spans;
  })();

  /**
   * Each entry is a per-HOST singleton: one instance per machine is correct, and a second one
   * in a forked request worker is pure duplicated work against the shared DB.
   */
  const HOST_SINGLETONS: Array<{ call: string; costsIfDuplicated: string }> = [
    {
      call: 'ensureHarnessFsWatcher',
      costsIfDuplicated: 'N inotify watchers per host — its uncaught ENOSPC was the fatal crash at 32 workers (EI-3385)',
    },
    {
      call: 'ensureHarnessStatusSweep',
      costsIfDuplicated: 'N x 30s PID-liveness sweeps writing harness_lanes/agent_runs (EI-19305266463631270)',
    },
    {
      call: 'startClaudeCredentialSync',
      costsIfDuplicated: 'N credential convergers racing rotating refresh tokens (EI-3385)',
    },
    {
      call: 'reconcileSpawnAdmissionOnBoot',
      costsIfDuplicated:
        'N workers redundantly running the same boot spawn-admission reclaim (candidate SELECT + a no-op UPDATE for every already-claimed row), with transient row-lock contention across them (EI-19303576975827285)',
    },
  ];

  it('finds the cluster.isPrimary guard blocks it is going to assert against', () => {
    // Guards the guard: if this file is refactored so the pattern no longer matches, the
    // per-singleton assertions below would all vacuously pass against an empty span list.
    expect(primarySpans.length).toBeGreaterThanOrEqual(HOST_SINGLETONS.length);
  });

  for (const { call, costsIfDuplicated } of HOST_SINGLETONS) {
    it(`starts ${call}() under cluster.isPrimary — else every forked worker duplicates it: ${costsIfDuplicated}`, () => {
      const re = new RegExp(`(?<![\\w.])${call}\\s*\\(`, 'g');
      const sites = [...masked.matchAll(re)].map((m) => m.index ?? -1);
      expect(sites.length).toBeGreaterThan(0);

      for (const at of sites) {
        const guarded = primarySpans.some(([s, e]) => at > s && at < e);
        expect(
          guarded,
          `${call}() is called at index ${at} OUTSIDE any if (cluster.isPrimary) block. ` +
            `A per-host singleton must not run in forked request workers: ${costsIfDuplicated}. ` +
            `Do not substitute backgroundWorkersEnabled() — it is env-only and a fork inherits env, ` +
            `and the dev-api drop-in sets PAPERCUSP_BACKGROUND_WORKERS=0 service-wide.`,
        ).toBe(true);
      }
    });
  }
});
