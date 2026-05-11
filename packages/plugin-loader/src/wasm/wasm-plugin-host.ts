/**
 * G2d — WASM plugin host. Loads a transpiled wasm component, calls its
 * lifecycle.init(), exposes call_action() + shutdown() against the
 * plugin's exports.
 *
 * Architecture (mirrors Rust runtime's WasmPlugin):
 *   1. Read manifest + verify signature (caller's responsibility before
 *      this function is invoked — install endpoint owns sig check).
 *   2. transpileWasm() → cached ESM at <cache>/<sha>/transpiled.js
 *   3. Dynamic-import the transpiled module
 *   4. Build host-impls (logging/http/secrets/events/compute) bound to
 *      this plugin's WasmHostCtx
 *   5. Call instantiate-async(coreModule, imports) → bindings object
 *   6. bindings.lifecycle.init() → PluginInfo
 *   7. Return a handle that exposes call_action + shutdown
 *
 * Per-plugin actor: this module DOESN'T spin up its own actor (JS is
 * single-threaded by default; concurrent calls to the same plugin
 * could re-enter wasmtime in problematic ways). v0.1.0 wraps each
 * call in a serial promise queue. opt-in `concurrency: 'parallel'`
 * in manifest will skip the queue for stateless plugins (deferred).
 */

import { transpileWasm, type Transpiler } from './transpile';
import {
  TokenBucket,
  makeImports,
  type AuditSink,
  type ComputeRuntime,
  type EventSink,
  type WasmHostCtx,
} from './host-impls';
import type { CapabilityCheckContext } from '../capabilities';

export interface WasmPluginConfig {
  /** Where transpiled wasm caches live. */
  cacheRoot: string;
  /** Production: realJcoTranspiler from jco-transpiler.ts */
  transpiler: Transpiler;
  /** Plugin's manifest-declared caps. */
  capCtx: CapabilityCheckContext;
  /** Per-plugin secrets store (cleartext map; backend persists to PG). */
  secrets: Map<string, string>;
  /** Where emitted events go. */
  eventSink: EventSink;
  /** Where audit rows go. */
  auditSink: AuditSink;
  /** Token bucket params for events.emit. */
  eventRateLimit?: { capacity: number; refillPerSec: number };
  /** What compute.exec should do. */
  computeRuntime?: ComputeRuntime;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  protocol: string;
}

export interface ActionInvokeResult {
  ok: boolean;
  /** When ok=true: payload bytes from plugin. */
  payload?: Uint8Array;
  /** When ok=false: typed error variant + message. */
  error?: { tag: 'not-found' | 'plugin-error' | 'invalid-payload'; message: string };
}

/**
 * Minimal shape of what the jco-transpiled module exports. The actual
 * type comes from jco's generated `.d.ts` per WIT version; we duck-type
 * here to avoid coupling at build time.
 */
interface TranspiledModule {
  instantiate(
    coreModuleProvider: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, unknown>,
  ): Promise<{
    lifecycle: {
      init(): Promise<{ tag: 'ok'; val: PluginInfo } | { tag: 'err'; val: unknown }>;
      shutdown(): Promise<void>;
    };
    actions: {
      invoke(
        name: string,
        payload: Uint8Array,
      ): Promise<{ tag: 'ok'; val: Uint8Array } | { tag: 'err'; val: { tag: string; val: string } }>;
    };
  }>;
}

/**
 * Live, instantiated WASM plugin. Returned from `loadWasmPlugin`.
 */
export class WasmPlugin {
  private serialQueue: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly pluginId: string,
    private readonly bindings: Awaited<ReturnType<TranspiledModule['instantiate']>>,
  ) {}

  /**
   * Serialize calls into the wasmtime store. Mirrors the Rust runtime's
   * mpsc-actor pattern. Without serialization, two concurrent calls could
   * trip wasmtime's single-threaded-store invariant.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serialQueue.then(() => fn(), () => fn());
    this.serialQueue = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<PluginInfo> {
    return this.serial(async () => {
      const r = await this.bindings.lifecycle.init();
      if (r.tag === 'ok') return r.val;
      throw new Error(`plugin init() returned error: ${JSON.stringify(r.val)}`);
    });
  }

  async shutdown(): Promise<void> {
    return this.serial(async () => {
      await this.bindings.lifecycle.shutdown();
    });
  }

  async callAction(actionName: string, payload: Uint8Array): Promise<ActionInvokeResult> {
    return this.serial(async () => {
      const r = await this.bindings.actions.invoke(actionName, payload);
      if (r.tag === 'ok') {
        return { ok: true, payload: r.val };
      }
      const err = r.val;
      return {
        ok: false,
        error: {
          tag: (err.tag as 'not-found' | 'plugin-error' | 'invalid-payload') || 'plugin-error',
          message: err.val ?? 'unknown error',
        },
      };
    });
  }
}

/**
 * Load + instantiate a WASM plugin from disk. This function:
 *   1. Transpiles the wasm via jco (cached by content hash)
 *   2. Dynamic-imports the transpiled ESM
 *   3. Builds host-imports from config
 *   4. Instantiates the component
 *   5. Returns a WasmPlugin handle
 *
 * Init is NOT called here — caller does that explicitly so it can
 * thread auth + decide what to do on init failure (e.g. roll back
 * a half-completed install).
 */
export async function loadWasmPlugin(
  pluginId: string,
  wasmPath: string,
  config: WasmPluginConfig,
): Promise<WasmPlugin> {
  const transpiled = await transpileWasm({
    wasmPath,
    cacheRoot: config.cacheRoot,
    transpiler: config.transpiler,
  });

  // Build the WasmHostCtx that all host-impls share.
  const ctx: WasmHostCtx = {
    pluginId,
    capCtx: config.capCtx,
    secrets: config.secrets,
    eventSink: config.eventSink,
    auditSink: config.auditSink,
    eventBucket: new TokenBucket(
      config.eventRateLimit?.capacity ?? 100,
      config.eventRateLimit?.refillPerSec ?? 100,
    ),
    computeRuntime: config.computeRuntime ?? { kind: 'disabled' },
  };

  const imports = makeImports(ctx);

  // Dynamic-import the transpiled ESM. URL fragment forces fresh
  // import each load (avoids module-cache reuse if the same wasm is
  // re-instantiated under different ctx).
  const url = `file://${transpiled.entryPath}#load=${Date.now()}`;
  const mod = (await import(/* @vite-ignore */ url)) as TranspiledModule;

  // Core wasm provider: jco's instantiate signature requires a function
  // that resolves a relative path (e.g. "transpiled.core.wasm") to a
  // compiled WebAssembly.Module. Read the file from the transpile dir.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const coreProvider = async (relPath: string): Promise<WebAssembly.Module> => {
    const full = path.join(transpiled.cacheDir, relPath);
    const bytes = await fs.readFile(full);
    return await WebAssembly.compile(bytes);
  };

  const bindings = await mod.instantiate(coreProvider, imports);
  return new WasmPlugin(pluginId, bindings);
}
