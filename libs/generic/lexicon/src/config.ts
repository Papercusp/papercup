/**
 * Host seam for ambient resolution.
 *
 * The pure resolver ({@link resolveTerm}) takes an explicit pack, which is
 * what React code does (it reads the flag and passes the pack id). But code
 * with no obvious place to thread a pack — server-emitted user-facing strings,
 * a notification builder, a doc-title formatter — needs to ask "which pack is
 * active right now?" without importing the flag system. That selection is the
 * one host-specific bit, injected here via `configureLexicon()`.
 *
 * Unconfigured, the ambient resolver falls back to the default pack (classic)
 * — branding must never throw. The host wires a real selector at startup
 * (see the operator's `lib/lexicon/configure.ts`).
 */
import { DEFAULT_PACK_ID } from './packs';
import { resolveTerm } from './resolver';
import type { BrandPackId, TermKey, TermOptions } from './types';

export interface LexiconHost {
  /** Which brand pack is active right now. Must be synchronous. */
  activePackId: () => BrandPackId;
}

const HOST_KEY = Symbol.for('@papercusp/lexicon:host');

interface HostGlobal {
  [HOST_KEY]?: LexiconHost;
}

/** Inject the active-pack selector. Process-global; last call wins. */
export function configureLexicon(host: LexiconHost): void {
  (globalThis as HostGlobal)[HOST_KEY] = host;
}

/** True once a host has been wired. */
export function isLexiconConfigured(): boolean {
  return (globalThis as HostGlobal)[HOST_KEY] !== undefined;
}

/**
 * The active pack id per the wired host, or the default when unconfigured.
 * Never throws — a missing host means "no rebrand", i.e. classic.
 */
export function activePackId(): BrandPackId {
  const host = (globalThis as HostGlobal)[HOST_KEY];
  if (!host) return DEFAULT_PACK_ID;
  try {
    return host.activePackId();
  } catch {
    return DEFAULT_PACK_ID;
  }
}

/**
 * Ambient resolve: resolve `key` against whatever pack the host says is
 * active. Use from non-React code; React should use the reactive hook so it
 * re-renders on a live flag flip.
 */
export function term(key: TermKey, opts?: TermOptions): string {
  return resolveTerm(activePackId(), key, opts);
}
