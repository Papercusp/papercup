/**
 * Phase 6b items 1 + 4 — process-level plugin lifecycle host.
 *
 * Owns:
 *   - the singleton `HookBus` for free-form `events:emit/listen:*` events
 *   - the discovered `LoadedPlugin[]` cache
 *   - per-(plugin, harness) lazy initialization of `init()` + `hooks.onLoad()`
 *   - the host-side fire helpers `firePluginLifecycle()` + `firePluginEvent()`
 *
 * Lifecycle hooks (the typed `PluginHooks` shape on the SDK) are called by
 * direct iteration. Free-form events (`events:emit:<name>`) flow through
 * the `HookBus` so plugins can subscribe via `addAction`/`addFilter`.
 *
 * Keep this module side-effect-free at import time — the first `await
 * getPluginHost()` triggers discovery so we don't wedge dev-server boot
 * behind plugin loading.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPlugins,
  HookBus,
  createPluginHookBus,
  hasCapability,
  ServerActionRegistry,
  type LoadedPlugin,
  type CapabilityCheckContext,
  type ActionDecl,
  type ActionResult,
} from '@papercusp/plugin-loader';
import type {
  PapercuspContext,
  PluginHooks,
  PluginSpawn,
  PluginSpawnResult,
} from '@papercusp/plugin-sdk';

import { papercuspRoot } from '@/lib/papercusp-root';
import {
  appendLogEventSync,
  installConsoleInterceptor,
  jsonlPathForStateDir,
  runWithPluginExecCtx,
  currentPluginExecCtx,
} from '@/lib/log-events';

// papercuspRoot() invalidates on registry mtime, so call it per-use.

// Install the global console.* interceptor on first import. AsyncLocalStorage
// scopes attribution to the active plugin handler — calls outside a plugin
// stack pass through unchanged. Idempotent.
installConsoleInterceptor();

interface HostState {
  loaded: LoadedPlugin[];
  loadErrors: Array<{ error: string; path: string }>;
  bus: HookBus;
  /** (pluginName, installSlug) → already initialized */
  initialized: Set<string>;
  /** (pluginName, installSlug) → sealed action registry from `init()`. */
  registries: Map<string, ServerActionRegistry>;
}

const __key = '__papercuspPluginHostRuntime';
type Globals = { [__key]?: { promise: Promise<HostState> | null; state: HostState | null; rootAtCache: string | null } };
const __globals = globalThis as Globals;
if (!__globals[__key]) __globals[__key] = { promise: null, state: null, rootAtCache: null };
const __cache = __globals[__key]!;

function discoverHarnessSlugs(): string[] {
  const dir = join(papercuspRoot(), 'harnesses');
  if (!existsSync(dir)) return [];
  try {
    // dynamic require to keep the module import-side-effect-free
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export interface PluginHostStatus {
  loaded: number;
  errors: number;
  hookRegistrations: { event: string; kind: 'action' | 'filter'; plugins: string[] }[];
}

async function discover(): Promise<HostState> {
  const bus = new HookBus();
  let loaded: LoadedPlugin[] = [];
  let loadErrors: Array<{ error: string; path: string }> = [];
  try {
    const r = await loadPlugins({ harnessSlugs: discoverHarnessSlugs() });
    loaded = r.loaded;
    loadErrors = r.errors;
  } catch (e: any) {
    loadErrors = [{ error: `discovery threw: ${e?.message ?? e}`, path: '<discovery>' }];
  }
  return { loaded, loadErrors, bus, initialized: new Set(), registries: new Map() };
}

function regKey(pluginName: string, installSlug: string): string {
  return `${pluginName}::${installSlug}`;
}

const SPAWN_DEFAULT_TIMEOUT_MS = 30_000;
const SPAWN_DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Build a capability-gated `ctx.spawn` for one plugin instance.
 *
 * Rejection cases (synchronous reject of the promise):
 *   - `bin` contains a path separator — only PATH-resolvable basenames are
 *     allowed. Plugins that need an absolute path should declare a wildcard
 *     cap like `compute:exec:my-tool*` and pass the basename.
 *   - Plugin lacks `compute:exec:<basename>` capability.
 *
 * Successful invocation:
 *   - Spawns via `node:child_process.spawn` with `shell: false` (no shell
 *     interpolation; args go to argv directly).
 *   - cwd defaults to the plugin's `pluginDataDir`.
 *   - Stdout/stderr captured up to `maxBufferBytes` (default 1 MiB each);
 *     overflow truncates with a `[truncated]` marker.
 *   - `timeoutMs` (default 30s) sends SIGTERM, then SIGKILL after 2s grace.
 */
function makePluginSpawn(args: {
  pluginName: string;
  capabilities: readonly string[];
  defaultCwd: string;
}): PluginSpawn {
  const capCtx: CapabilityCheckContext = {
    pluginName: args.pluginName,
    capabilities: args.capabilities as any,
  };
  return async function spawn(bin, argv, opts) {
    if (typeof bin !== 'string' || bin.length === 0) {
      throw new Error(`plugin "${args.pluginName}" ctx.spawn: bin must be a non-empty string`);
    }
    if (bin.includes('/') || bin.includes('\\')) {
      throw new Error(
        `plugin "${args.pluginName}" ctx.spawn: bin "${bin}" must be a basename, not a path. ` +
        `Declare a 'compute:exec:<name>' capability and pass just the binary name; PATH lookup will resolve it.`,
      );
    }
    const cap = `compute:exec:${bin}`;
    if (!hasCapability(capCtx, cap)) {
      throw new Error(
        `plugin "${args.pluginName}" missing capability "${cap}". ` +
        `Add it to the plugin's manifest \`capabilities[]\` (or a wildcard like 'compute:exec:py-*').`,
      );
    }
    const cp = require('node:child_process') as typeof import('node:child_process');
    const fsSync = require('node:fs') as typeof import('node:fs');
    const cwd = opts?.cwd ?? args.defaultCwd;
    // The default cwd is the plugin's pluginDataDir, which may not exist yet
    // on first spawn. Ensure it before handing to libuv (which would
    // otherwise reject the spawn with ENOENT).
    try { fsSync.mkdirSync(cwd, { recursive: true }); } catch { /* ignore — caller will see the spawn error */ }
    const env = { ...process.env, ...(opts?.env ?? {}) };
    const timeoutMs = opts?.timeoutMs ?? SPAWN_DEFAULT_TIMEOUT_MS;
    const maxBuffer = opts?.maxBufferBytes ?? SPAWN_DEFAULT_MAX_BUFFER;
    return new Promise<PluginSpawnResult>((resolve, reject) => {
      let child: import('node:child_process').ChildProcessWithoutNullStreams;
      try {
        child = cp.spawn(bin, [...argv], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e: any) {
        reject(e);
        return;
      }
      let stdout = '';
      let stderr = '';
      let stdoutTrunc = false;
      let stderrTrunc = false;
      let killed = false;
      const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
        if (which === 'stdout') {
          if (stdoutTrunc) return;
          if (stdout.length + chunk.length > maxBuffer) {
            stdout += chunk.toString('utf8', 0, Math.max(0, maxBuffer - stdout.length));
            stdout += '\n[truncated]';
            stdoutTrunc = true;
          } else {
            stdout += chunk.toString('utf8');
          }
        } else {
          if (stderrTrunc) return;
          if (stderr.length + chunk.length > maxBuffer) {
            stderr += chunk.toString('utf8', 0, Math.max(0, maxBuffer - stderr.length));
            stderr += '\n[truncated]';
            stderrTrunc = true;
          } else {
            stderr += chunk.toString('utf8');
          }
        }
      };
      child.stdout.on('data', (c: Buffer) => append('stdout', c));
      child.stderr.on('data', (c: Buffer) => append('stderr', c));
      child.on('error', (e) => reject(e));
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref();
      }, timeoutMs);
      timer.unref();
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, killed });
      });
      if (opts?.stdin !== undefined) {
        try { child.stdin.write(opts.stdin); } catch { /* ignore */ }
      }
      try { child.stdin.end(); } catch { /* ignore */ }
    });
  };
}

export function getPluginHost(): Promise<HostState> {
  // Workspace-switch invalidation: if papercuspRoot() resolves to a
  // different path than when the cache was populated, re-discover.
  // Tauri's app.restart() handles this in production by replacing the
  // entire process; this branch covers dev/web mode where workspaces
  // can flip via registry edits without a process restart.
  //
  // The check is against rootAtCache being NOT EQUAL to rootNow (rather
  // than rootAtCache being truthy) so it correctly invalidates when the
  // global cache survived a Next HMR cycle but rootAtCache wasn't yet
  // tracked by the prior module instance.
  const rootNow = papercuspRoot();
  if (__cache.promise && __cache.rootAtCache !== rootNow) {
    _resetPluginHostForTests();
    __cache.rootAtCache = null;
  }
  if (__cache.promise) return __cache.promise;
  __cache.rootAtCache = rootNow;
  __cache.promise = (async () => {
    const state = await discover();
    __cache.state = state;
    return state;
  })();
  return __cache.promise;
}

/**
 * Build a per-(plugin, harness) `PapercuspContext`. The plugin's
 * `pluginDataDir` is rooted at `<stateDir>/plugins/<plugin-name>/`.
 *
 * Caller passes a project's filesystem layout — the host doesn't reach
 * back into project-registry code so that this module stays pure.
 */
export function buildPapercuspContext(args: {
  pluginName: string;
  installSlug: string;
  projectDir: string;
  stateDir: string;
  log?: (msg: string) => void;
  /**
   * Override the default `stateDir/plugin-data/<name>/` location for the
   * plugin's data dir. Needed when the run.log lives in one tree (the
   * project's `.harness/`) but plugin configs live in a different tree
   * (the workspace's `<harnessDir>/plugin-data/<scoped-slug>/`). When
   * omitted the legacy default applies.
   */
  pluginDataDirOverride?: string;
}): PapercuspContext {
  const { pluginName, installSlug, projectDir, stateDir, log, pluginDataDirOverride } = args;
  const jsonlPath = jsonlPathForStateDir(stateDir);
  // Default ctx.log writes a structured event to run.log.jsonl AND mirrors
  // to stdout (which the console interceptor will also capture if we're
  // inside a plugin exec scope — that's deliberate; lets plugins use either
  // ctx.log() or console.log() interchangeably).
  const defaultLog = (msg: string): void => {
    const exec = currentPluginExecCtx();
    appendLogEventSync(jsonlPath, {
      ts: new Date().toISOString(),
      source: `plugin:${pluginName}`,
      level: 'info',
      msg,
      ...(exec?.corrId ? { corrId: exec.corrId } : {}),
    });
    // Mirror to stdout so existing dev workflows (tail of next-server log)
    // still see the line. The console interceptor would re-record this,
    // so guard with the same exec context check it uses — but we already
    // wrote the JSONL line above, so just print plain.
    process.stdout.write(`[plugin:${pluginName}@${installSlug}] ${msg}\n`);
  };
  return {
    installSlug,
    projectDir,
    stateDir,
    // 'plugin-data/' (with dash) matches the convention the papercusp CLI
    // uses when it mirrors plugin-configs/<slug>.json → plugin-data/<slug>/
    // config.json at invoke time. Plugins read from ctx.pluginDataDir, so
    // both code paths must agree on this prefix or in-process invocations
    // see no config and the CLI does.
    pluginDataDir: pluginDataDirOverride ?? join(stateDir, 'plugin-data', pluginName),
    log: log ?? defaultLog,
  };
}

/**
 * Attach the dynamic ctx extras (actions registry, capability-gated spawn)
 * to a freshly-built `PapercuspContext`. The lifecycle-firing loop builds
 * a fresh ctx for each handler invocation; this helper keeps the shape
 * consistent across `init()`, `onLoad()`, and every typed lifecycle hook.
 *
 * ServerActionRegistry's handler signature uses `ctx: unknown` (host-
 * agnostic). PluginActionRegistry types it as `ctx: PapercuspContext`.
 * The cast bridges that contravariance — the host always passes a real
 * PapercuspContext.
 */
function attachPluginCtxExtras(
  ctx: PapercuspContext,
  lp: LoadedPlugin,
  registry: ServerActionRegistry,
): void {
  ctx.actions = registry as unknown as PapercuspContext['actions'];
  ctx.spawn = makePluginSpawn({
    pluginName: lp.plugin.name,
    capabilities: lp.plugin.capabilities ?? [],
    defaultCwd: ctx.pluginDataDir,
  });

  // ctx.oauth.token(field): plugins that declare oauth in their manifest
  // can call this to acquire a fresh access token. Resolution of which
  // provider backs `field` comes from the plugin's manifest oauth[] entries.
  const oauthDecls =
    ((lp.plugin as unknown as { oauth?: { provider: string; scopes?: string[]; fieldName: string }[] }).oauth) ?? [];
  ctx.oauth = {
    async token(field: string): Promise<string | null> {
      // Lazy-loaded to avoid a circular import at module-eval time.
      const { getOAuthToken } = await import('@/lib/oauth/token');
      const { fsTokenStorage } = await import('@/lib/oauth/storage-fs');
      return getOAuthToken(
        {
          plugin: lp.plugin.name,
          harness: ctx.installSlug,
          resolveProvider: (f) => {
            const decl = oauthDecls.find((o) => o.fieldName === f);
            if (!decl) return null;
            return { provider: decl.provider, scopes: decl.scopes };
          },
          storage: fsTokenStorage,
        },
        field,
      );
    },
  };

  // ctx.recordResource: writes a record to the provision WAL. Used by
  // in-process plugins that don't shell out to a setup script — for
  // example, a plugin that creates a GitHub repo from a hook handler.
  ctx.recordResource = async (input) => {
    const { appendWalEntry } = await import('@/lib/provision/state-store');
    await appendWalEntry(ctx.installSlug, lp.plugin.name, {
      kind: input.kind,
      externalId: input.externalId,
      recordedAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  };
}

/**
 * Run a plugin handler under the AsyncLocalStorage scope so console.log/.warn/.error
 * inside it (and anywhere down the async stack) get attributed to this
 * plugin/harness pair in run.log.jsonl. Returns whatever the wrapped
 * function returns (sync or async — handled transparently).
 */
async function runUnderPluginCtx<T>(
  pluginName: string,
  ctx: PapercuspContext,
  corrId: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(
    runWithPluginExecCtx(
      {
        pluginSlug: pluginName,
        harnessSlug: ctx.installSlug,
        jsonlPath: jsonlPathForStateDir(ctx.stateDir),
        ...(corrId ? { corrId } : {}),
      },
      fn,
    ),
  );
}

async function ensureInitialized(
  state: HostState,
  lp: LoadedPlugin,
  ctx: PapercuspContext,
): Promise<void> {
  const key = regKey(lp.plugin.name, ctx.installSlug);
  if (state.initialized.has(key)) return;
  state.initialized.add(key);

  // Register the plugin's free-form hook subscriptions first so an init()
  // that fires its own events can reach its own filters/actions.
  const capCtx: CapabilityCheckContext = {
    pluginName: lp.plugin.name,
    capabilities: lp.plugin.capabilities ?? [],
  };
  void createPluginHookBus(state.bus, capCtx);

  // Build a per-(plugin, harness) action registry. Plugins receive it as
  // `ctx.actions` and call `ctx.actions.register(name, handler)` from
  // `init()`. The registry validates each registration against the
  // manifest-declared `actions[]` and the plugin's declared capabilities.
  // After init returns we seal the registry so registrations are immutable.
  //
  // The SDK's typed `PapercuspContext` doesn't declare `actions` (intentionally
  // — the SDK is host-agnostic), so we attach via cast. Plugins that don't
  // touch ctx.actions are unaffected.
  const declaredActions = ((lp.plugin as unknown as { actions?: ActionDecl[] }).actions) ?? [];
  let registry: ServerActionRegistry;
  try {
    registry = new ServerActionRegistry(declaredActions, {
      pluginName: lp.plugin.name,
      pluginCapabilities: lp.plugin.capabilities ?? [],
    });
  } catch (e: any) {
    ctx.log(`action registry init threw: ${e?.message ?? e}`);
    return;
  }
  state.registries.set(key, registry);
  attachPluginCtxExtras(ctx, lp, registry);

  try {
    await runUnderPluginCtx(lp.plugin.name, ctx, undefined, async () => {
      if (typeof lp.plugin.init === 'function') {
        await lp.plugin.init(ctx);
      }
      const onLoad = lp.plugin.hooks?.onLoad;
      if (typeof onLoad === 'function') {
        await onLoad(ctx);
      }
    });
  } catch (e: any) {
    ctx.log(`init/onLoad threw: ${e?.message ?? e}`);
  } finally {
    registry.seal();
  }
}

/**
 * Look up a sealed action registry for a (plugin, harness) pair. Returns
 * null if the pair hasn't been initialized yet — caller may want to fire
 * a lifecycle event first (e.g., `beforeMissionStart`) to trigger init.
 */
export async function getActionRegistry(
  pluginName: string,
  installSlug: string,
): Promise<ServerActionRegistry | null> {
  const state = await getPluginHost();
  return state.registries.get(regKey(pluginName, installSlug)) ?? null;
}

/**
 * Invoke a plugin action by name. Triggers lazy `(plugin, harness)` init
 * if needed, then dispatches to the registered handler with the supplied
 * params + an AbortSignal. Returns the handler's `{ok, result?, error?}`
 * envelope.
 */
export async function invokePluginAction(args: {
  pluginName: string;
  actionName: string;
  installSlug: string;
  projectDir: string;
  stateDir: string;
  pluginDataDirOverride?: string;
  params?: unknown;
  triggerSource?: 'cli' | 'ui' | 'mission-done' | 'webhook' | 'api';
  triggerId?: string;
}): Promise<ActionResult> {
  const state = await getPluginHost();
  const lp = state.loaded.find((p) => p.plugin.name === args.pluginName);
  if (!lp) return { ok: false, error: `plugin "${args.pluginName}" not loaded` };
  const ctx = buildPapercuspContext({
    pluginName: lp.plugin.name,
    installSlug: args.installSlug,
    projectDir: args.projectDir,
    stateDir: args.stateDir,
    ...(args.pluginDataDirOverride ? { pluginDataDirOverride: args.pluginDataDirOverride } : {}),
  });
  await ensureInitialized(state, lp, ctx);
  const registry = state.registries.get(regKey(lp.plugin.name, args.installSlug));
  if (!registry) return { ok: false, error: `no action registry for "${args.pluginName}@${args.installSlug}" — init may have failed` };
  // ensureInitialized worked on its own ctx — attach the same extras to
  // this ctx (which is what the action handler will receive as its first arg).
  attachPluginCtxExtras(ctx, lp, registry);
  // Mint a correlation id per invocation so every line emitted during
  // this run (ctx.log + console.* + final result) is threadable in the UI.
  const corrId = args.triggerId ?? `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const jsonlPath = jsonlPathForStateDir(ctx.stateDir);
  // Mark invocation start in run.log.jsonl so the UI can scope the "this
  // invocation only" filter chip.
  appendLogEventSync(jsonlPath, {
    ts: new Date().toISOString(),
    source: `plugin:${lp.plugin.name}`,
    level: 'info',
    msg: `→ invoke ${args.actionName}`,
    corrId,
    attrs: { triggerSource: args.triggerSource ?? 'api', params: args.params },
  });
  const result = await runUnderPluginCtx(lp.plugin.name, ctx, corrId, () =>
    registry.invoke({
      name: args.actionName,
      ctx,
      params: args.params,
      triggerSource: args.triggerSource ?? 'api',
      triggerId: corrId,
    }),
  );
  // Final structured event: always lands in run.log.jsonl regardless of
  // whether the plugin called ctx.log itself. This is what makes the
  // cloudflare-pages publish URL visible in the panel even though the
  // plugin's runPublish() doesn't emit a final ctx.log.
  appendLogEventSync(jsonlPath, {
    ts: new Date().toISOString(),
    source: `plugin:${lp.plugin.name}`,
    level: result.ok ? 'info' : 'error',
    msg: result.ok
      ? `✓ ${args.actionName} ok`
      : `✗ ${args.actionName} failed: ${result.error ?? 'unknown error'}`,
    corrId,
    attrs: result.ok ? { result: result.result } : { error: result.error },
  });
  return result;
}

/**
 * Initialize every loaded plugin for the given harness slug. Idempotent
 * per (plugin, slug) pair — repeat calls are no-ops. Errors in one plugin's
 * init are caught + logged; never aborts the others.
 *
 * Called eagerly by `firePluginLifecycle` on every fire so plugins without
 * the specific hook handler still get their `init()` run on first contact
 * with a harness. Also exposed for explicit warm-up paths (e.g., a server
 * startup hook that wants to surface init errors before the first event).
 */
export async function warmUpPluginsForSlug(args: {
  installSlug: string;
  projectDir: string;
  stateDir: string;
}): Promise<void> {
  const state = await getPluginHost();
  for (const lp of state.loaded) {
    const ctx = buildPapercuspContext({
      pluginName: lp.plugin.name,
      installSlug: args.installSlug,
      projectDir: args.projectDir,
      stateDir: args.stateDir,
    });
    await ensureInitialized(state, lp, ctx);
  }
}

/**
 * Fire one of the typed `PluginHooks` events at every loaded plugin that
 * declares a handler. Each handler runs sequentially with its own
 * per-(plugin, harness) ctx. Errors are caught + logged; one bad plugin
 * never aborts the chain.
 *
 * Lazy-initializes every loaded plugin for the slug on first fire (so
 * plugins without this specific hook handler still run their `init()`).
 */
export async function firePluginLifecycle<K extends keyof PluginHooks>(
  event: K,
  args: {
    installSlug: string;
    projectDir: string;
    stateDir: string;
  },
  ...payload: PluginHooks[K] extends ((ctx: PapercuspContext, ...rest: infer R) => any) | undefined ? R : never
): Promise<void> {
  await warmUpPluginsForSlug(args);
  const state = await getPluginHost();
  for (const lp of state.loaded) {
    const handler = lp.plugin.hooks?.[event];
    if (typeof handler !== 'function') continue;
    const ctx = buildPapercuspContext({
      pluginName: lp.plugin.name,
      installSlug: args.installSlug,
      projectDir: args.projectDir,
      stateDir: args.stateDir,
    });
    const registry = state.registries.get(regKey(lp.plugin.name, args.installSlug));
    if (registry) attachPluginCtxExtras(ctx, lp, registry);
    try {
      await runUnderPluginCtx(lp.plugin.name, ctx, undefined, async () => {
        // Cast through `any` — the conditional-type indexed handler doesn't
        // narrow well across the Promise return inside Array#forEach style
        // iteration; we've validated `typeof handler === 'function'`.
        await (handler as any)(ctx, ...payload);
      });
    } catch (e: any) {
      ctx.log(`hook "${String(event)}" threw: ${e?.message ?? e}`);
    }
  }

  // Fire any expert triggers registered for this lifecycle event. Best-effort;
  // failures here don't block the plugin event chain (see lib/expert-triggers.ts).
  try {
    const { fireLifecycleTriggers } = await import('./expert-triggers');
    void fireLifecycleTriggers(String(event), args.installSlug, {
      projectDir: args.projectDir,
      stateDir: args.stateDir,
      payload: payload[0],
    }).catch((e) => console.warn(`[expert-triggers] lifecycle ${String(event)}:`, (e as Error).message));
  } catch { /* expert-triggers module failed to load — ignore */ }
}

/**
 * Fire a free-form `events:emit:<name>` event through the HookBus. Returns
 * after all action handlers have run. Filters are not fired here — use
 * `applyPluginFilter()` for value-transform chains.
 */
export async function firePluginEvent<T = unknown>(event: string, arg: T): Promise<void> {
  const state = await getPluginHost();
  await state.bus.runAction(event, arg, (msg) => console.warn(msg));
  // Fire any expert triggers registered for this event. Same best-effort
  // semantics as firePluginLifecycle.
  try {
    const { fireEventTriggers } = await import('./expert-triggers');
    const installSlug = (typeof arg === 'object' && arg !== null && 'installSlug' in arg)
      ? String((arg as Record<string, unknown>).installSlug ?? '')
      : '';
    if (installSlug) {
      void fireEventTriggers(event, installSlug, arg)
        .catch((e) => console.warn(`[expert-triggers] event ${event}:`, (e as Error).message));
    }
  } catch { /* ignore */ }
}

export async function applyPluginFilter<T = unknown>(event: string, value: T): Promise<T> {
  const state = await getPluginHost();
  return state.bus.applyFilter(event, value);
}

export async function pluginHostStatus(): Promise<PluginHostStatus & {
  plugins: Array<{ name: string; version: string; source: string }>;
  loadErrors: Array<{ error: string; path: string }>;
  initializedPairs: string[];
  registeredActions: Array<{ key: string; declared: string[]; registered: string[] }>;
}> {
  const state = await getPluginHost();
  return {
    loaded: state.loaded.length,
    errors: state.loadErrors.length,
    hookRegistrations: state.bus.inspect(),
    plugins: state.loaded.map((lp) => ({ name: lp.plugin.name, version: lp.plugin.version, source: lp.source })),
    loadErrors: state.loadErrors,
    initializedPairs: Array.from(state.initialized).sort(),
    registeredActions: Array.from(state.registries.entries()).map(([key, r]) => ({
      key,
      declared: r.declaredNames(),
      registered: r.registeredNames(),
    })),
  };
}

/** Tests-only: drop the cached host so the next call re-discovers. */
export function _resetPluginHostForTests(): void {
  __cache.promise = null;
  __cache.state = null;
  // Also clear Node's CJS require.cache for plugin entry files so
  // freshly-recompiled plugin code is actually re-read on next discovery.
  // Without this, `createRequire(...).require(entryPath)` returns the
  // previously-loaded module object even after the host cache is cleared.
  // Symlinks under ~/.papercusp/global-plugins/ are followed to their real
  // paths before being cached, so we match against the resolved targets.
  try {
    const root = join(papercuspRoot(), 'global-plugins');
    const fs = require('node:fs') as typeof import('node:fs');
    const resolvedRoots = new Set<string>();
    const collectRealpaths = (dir: string, depth: number): void => {
      if (depth > 2) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          resolvedRoots.add(real);
        } catch {
          continue;
        }
        // npm-style scope dirs (`@papercupai/`) hold one or more plugin
        // dirs as children; their symlink targets must be resolved too,
        // otherwise require.cache keyed on the source-tree realpath
        // survives a reset and stale module objects keep being served.
        if (entry.name.startsWith('@')) {
          collectRealpaths(full, depth + 1);
        }
      }
    };
    if (fs.existsSync(root)) {
      collectRealpaths(root, 0);
    }
    for (const k of Object.keys(require.cache)) {
      const matches =
        k.startsWith(root) ||
        Array.from(resolvedRoots).some((r) => k.startsWith(r));
      if (matches) delete require.cache[k];
    }
  } catch {
    /* require.cache may not exist in non-CJS contexts */
  }
}

/**
 * Tests-only: inject a fixed list of `LoadedPlugin` records directly,
 * bypassing filesystem discovery. The next `getPluginHost()` call returns
 * the injected state (instead of running `loadPlugins`). Subsequent
 * `_resetPluginHostForTests()` clears the override and restores normal
 * filesystem discovery on the next call.
 */
export function _injectPluginHostForTests(loaded: LoadedPlugin[]): void {
  const state: HostState = {
    loaded,
    loadErrors: [],
    bus: new HookBus(),
    initialized: new Set(),
    registries: new Map(),
  };
  __cache.state = state;
  __cache.promise = Promise.resolve(state);
}

/**
 * Dev-mode plugin hot-reload: watch the global-plugins directory and reset
 * the host cache whenever a plugin's manifest or entry file changes. Idempotent
 * — repeat calls are no-ops once the watcher is armed.
 *
 * Returns a `dispose()` to stop watching. Watcher is intentionally cheap
 * (manifest-level only); it doesn't try to re-import in place. Next request
 * after a change pays the discovery cost.
 *
 * Opt in via `PAPERCUSP_DEV_PLUGIN_WATCH=1` (the operator's bootstrap reads
 * this env on startup). Avoid in production where filesystem-watch overhead
 * compounds on shared hosts.
 */
const __watchKey = '__papercuspPluginHostWatcher';
type WatchGlobals = { [__watchKey]?: { dispose: () => void } | null };
const __watchGlobals = globalThis as WatchGlobals;

export function watchPluginsForReload(opts: { dir?: string } = {}): { dispose: () => void } {
  if (__watchGlobals[__watchKey]) return __watchGlobals[__watchKey]!;
  const dir = opts.dir ?? join(papercuspRoot(), 'global-plugins');
  const fs = require('node:fs') as typeof import('node:fs');
  if (!existsSync(dir)) {
    const noop = { dispose: () => {} };
    __watchGlobals[__watchKey] = noop;
    return noop;
  }
  let pending: NodeJS.Timeout | null = null;
  const reset = (filename: string | null) => {
    // Debounce — editor saves can stat-touch the same file 3-4 times in a
    // row, and we only need one reset per burst.
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (filename) console.log(`[plugin-host] hot-reload: ${filename} changed → resetting plugin runtime cache`);
      _resetPluginHostForTests();
      try {
        const { _resetPluginApiRoutesForTests } = require('./plugin-api-mount');
        _resetPluginApiRoutesForTests();
      } catch { /* ignore */ }
    }, 250);
  };
  const watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    // Only react to manifest / entry-point changes — node_modules churn or
    // editor swap files would otherwise reset on every keystroke.
    if (/papercusp\.json$|\/index\.(?:m?js|ts)$|\/dist\/index\.js$/.test(filename)) {
      reset(filename);
    }
  });
  const handle = {
    dispose: () => {
      if (pending) clearTimeout(pending);
      try { watcher.close(); } catch { /* ignore */ }
      __watchGlobals[__watchKey] = null;
    },
  };
  __watchGlobals[__watchKey] = handle;
  console.log(`[plugin-host] hot-reload watcher armed on ${dir}`);
  return handle;
}
