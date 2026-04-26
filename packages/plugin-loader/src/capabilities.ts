/**
 * Capability enforcement for plugin runtime.
 *
 * Each loaded plugin declares its `capabilities[]` in the manifest. The DI
 * container wraps every host service in a Proxy that checks the plugin's
 * declared caps before delegating.
 *
 * Capability format: namespace:action[:resource]
 *   - 'tasks:read'                    — generic
 *   - 'http:fetch:youtube.com'        — resource-scoped (domain)
 *   - 'secrets:read:YOUTUBE_API_KEY'  — resource-scoped (secret name)
 *
 * Runtime errors:
 *   - MissingCapabilityError — declared method exists but plugin lacks the cap
 *   - UnknownMethodError     — service has no method named X
 */

import type { Capability, ServiceDef } from '@papercusp/plugin-sdk';

export class MissingCapabilityError extends Error {
  constructor(public pluginName: string, public capability: Capability | string) {
    super(
      `plugin "${pluginName}" missing capability "${capability}". ` +
      `Add it to the plugin's manifest \`capabilities[]\`.`
    );
    this.name = 'MissingCapabilityError';
  }
}

export class UnknownMethodError extends Error {
  constructor(public service: string, public method: string) {
    super(`service "${service}" has no method "${method}"`);
    this.name = 'UnknownMethodError';
  }
}

export interface CapabilityCheckContext {
  pluginName: string;
  capabilities: Capability[];
}

/**
 * Check whether a plugin holds a specific capability.
 *
 * Supports literal match AND resource-scoped wildcard match. e.g., a plugin
 * declaring `'http:fetch:youtube.com'` would pass a check for that exact
 * string. We do NOT support `*` wildcards in declared capabilities — that
 * would defeat the purpose. Plugins must enumerate domains/names explicitly.
 */
export function hasCapability(ctx: CapabilityCheckContext, cap: Capability | string): boolean {
  return ctx.capabilities.includes(cap as Capability);
}

/**
 * Throw MissingCapabilityError if the plugin doesn't have the cap.
 */
export function requireCapability(ctx: CapabilityCheckContext, cap: Capability | string): void {
  if (!hasCapability(ctx, cap)) {
    throw new MissingCapabilityError(ctx.pluginName, cap);
  }
}

/**
 * Wrap a "real service" with a Proxy that checks caps before delegating.
 *
 * Usage:
 *   const realTasks = makeRealTasksService(db);
 *   const TasksDef = defineService({
 *     name: 'tasks',
 *     methods: {
 *       list: { capability: 'tasks:read' },
 *       get:  { capability: 'tasks:read' },
 *       create: { capability: 'tasks:write' },
 *     }
 *   });
 *   const scopedTasks = wrapServiceWithCaps(plugin, realTasks, TasksDef);
 *   // Plugin's UI/hooks now use scopedTasks.list() etc., capability-checked.
 */
export function wrapServiceWithCaps<T extends Record<string, (...a: any[]) => any>>(
  ctx: CapabilityCheckContext,
  realService: T,
  serviceDef: ServiceDef
): T {
  // Skip Symbol props and well-known JS introspection keys to keep the proxy
  // playing nice with `typeof`, `for-in`, `Object.keys`, error stringification, etc.
  const PASS_THROUGH_KEYS = new Set([
    'then', 'catch', 'finally',                             // promise interop
    Symbol.toPrimitive as unknown as string,
    Symbol.iterator as unknown as string,
    Symbol.asyncIterator as unknown as string,
    'toString', 'valueOf', 'inspect', 'constructor',
  ]);

  return new Proxy(realService, {
    get(target, prop, receiver) {
      // Symbol or known-pass-through key: defer to real target.
      if (typeof prop === 'symbol' || PASS_THROUGH_KEYS.has(prop as string)) {
        return Reflect.get(target, prop, receiver);
      }

      // Method declared in the service def → return capability-checked wrapper.
      const methodDef = serviceDef.methods[prop as string];
      if (methodDef) {
        const realMethod = target[prop as keyof T] as ((...a: any[]) => any) | undefined;
        if (typeof realMethod !== 'function') {
          // Service def declared the method but the real service doesn't implement it. Programming error.
          throw new Error(`service "${serviceDef.name}" missing implementation for method "${String(prop)}"`);
        }
        return (...args: any[]) => {
          const requiredCap =
            typeof methodDef.capability === 'function'
              ? methodDef.capability(...args)
              : methodDef.capability;
          requireCapability(ctx, requiredCap);
          return realMethod.apply(target, args);
        };
      }

      // Method NOT declared in service def — block all access (including
      // non-function props, since plugins shouldn't poke at service internals).
      throw new UnknownMethodError(serviceDef.name, String(prop));
    },
  }) as T;
}

/**
 * Wrap fetch with domain allowlist enforcement. Plugin can only hit domains
 * that appear in its `http:fetch:<domain>` capabilities.
 *
 * Domain matching: exact host. Subdomains do NOT match wildcards in the
 * declared cap; declare each one explicitly. (Future: allow `*.domain.com`
 * if needed; for now, strict.)
 */
export function makeFetchProxy(
  ctx: CapabilityCheckContext,
  realFetch: typeof fetch = fetch
): typeof fetch {
  // fetch must always return a promise — even on validation failure.
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' ? input : input.toString();
    let host: string;
    try {
      host = new URL(urlString).hostname;
    } catch {
      return Promise.reject(new Error(`plugin "${ctx.pluginName}" attempted invalid URL: ${urlString}`));
    }
    const cap: Capability = `http:fetch:${host}`;
    if (!hasCapability(ctx, cap)) {
      return Promise.reject(new MissingCapabilityError(ctx.pluginName, cap));
    }
    return realFetch(input as any, init);
  }) as typeof fetch;
}

/**
 * Wrap the secrets service so each `read(name)` call checks for the
 * resource-specific capability `secrets:read:<NAME>`. Plugins must
 * declare each secret they need by name; no wildcards.
 */
export function makeSecretsProxy(
  ctx: CapabilityCheckContext,
  resolve: (name: string) => Promise<string>
) {
  return {
    async read(name: string): Promise<string> {
      const cap: Capability = `secrets:read:${name}`;
      requireCapability(ctx, cap);
      return resolve(name);
    },
  };
}
