/**
 * Mockup-to-implementation validation: binding the verbs to real dependencies.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-006, D-017).
 *
 * `verbs.ts` is host-agnostic and `host-registry.ts` is a slot. This is the one
 * place that knows what the production dependencies actually are — Postgres,
 * lost-pixel's pixelmatch comparator, the filesystem — and it is called from
 * plugin discovery so the design-phase plugin finds its surface installed.
 *
 * ─── EVERYTHING HERE IS LAZY, ON PURPOSE ─────────────────────────────────────
 *
 * Boot installs a surface per harness, and a host serves many. Building the
 * dependencies eagerly would open a Postgres connection and resolve lost-pixel
 * for every harness at startup, whether or not anyone ever ratifies a design.
 * So construction is deferred to the first call and then memoised.
 *
 * The one thing NOT deferred is engine resolution INSIDE a call:
 * `createPixelmatchProvider` throws at construction when lost-pixel is missing,
 * which is deliberate (a provider that cannot name its engine version cannot
 * stamp a result), and that throw surfaces as a refusal from the verb rather
 * than as a comparison that silently used something else.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { installDesignCompareVerbs } from './host-registry';
import { createPgReferenceStore, type SqlTag } from './reference-store-pg';
import { createPixelmatchProvider } from './provider';
import type { ReferenceImageRef } from './reference-store';
import {
  type DesignCompareVerbs,
  type ReferenceImageMaterializer,
  type VerbDeps,
  createDesignCompareVerbs,
} from './verbs';

/**
 * Turn a stored locator into a path an engine can read.
 *
 * Three forms are accepted, and an unrecognised one is REPORTED rather than
 * guessed at: a locator we cannot resolve must become a `reference-unreadable`
 * refusal, never a comparison against some path we invented.
 */
export const filesystemReferenceMaterializer: ReferenceImageMaterializer = async (
  image: ReferenceImageRef,
) => {
  const { locator } = image;

  if (locator.startsWith('data:')) {
    const comma = locator.indexOf(',');
    const header = comma === -1 ? '' : locator.slice(0, comma);
    if (comma === -1 || !header.includes(';base64')) {
      return {
        error:
          'a data: locator must be base64-encoded; a percent-encoded one cannot be decoded to the exact ' +
          'bytes that were hashed at ratification, and comparing anything else would compare a different image',
      };
    }
    try {
      const bytes = Buffer.from(locator.slice(comma + 1), 'base64');
      const dir = mkdtempSync(join(tmpdir(), 'papercusp-design-ref-'));
      const path = join(dir, 'reference.png');
      writeFileSync(path, bytes);
      return { path };
    } catch (error) {
      return { error: `failed to decode data: locator — ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (locator.startsWith('file://')) {
    const path = locator.slice('file://'.length);
    return existsSync(path) ? { path } : { error: `file:// locator does not exist on this host: ${path}` };
  }

  if (locator.startsWith('/')) {
    return existsSync(locator) ? { path: locator } : { error: `path does not exist on this host: ${locator}` };
  }

  return {
    error:
      `unrecognised locator form '${locator.slice(0, 40)}…': expected an absolute path, a file:// URL, ` +
      'or a base64 data: URL. A relative path is refused because it would resolve against whatever ' +
      'working directory the host happens to have.',
  };
};

/** Build the production dependency bundle for one harness. */
async function buildDeps(harnessSlug: string): Promise<VerbDeps> {
  // Lazy so this module stays import-side-effect-free and the driver is not
  // pulled into a browser/bundle graph that never calls these verbs.
  const postgres = (await import('postgres')).default;
  const sql = postgres(getHarnessAdminUrl(), { max: 2, idle_timeout: 30 });
  return {
    harnessSlug,
    store: createPgReferenceStore({ sql: sql as unknown as SqlTag }),
    now: () => Date.now(),
    clock: () => new Date().toISOString(),
    materializeReferenceImage: filesystemReferenceMaterializer,
    comparison: { provider: createPixelmatchProvider() },
  };
}

/**
 * Install a lazily-bound verb surface for one harness.
 *
 * Idempotent: `installDesignCompareVerbs` replaces by harness, so a dev-mode
 * plugin reload does not accumulate surfaces holding closed handles.
 */
export function installDesignCompareForHarness(harnessSlug: string): void {
  let pending: Promise<VerbDeps> | null = null;
  const deps = (): Promise<VerbDeps> => (pending ??= buildDeps(harnessSlug));

  const verbs: DesignCompareVerbs = {
    async ratifyReference(input, caller) {
      return createDesignCompareVerbs(await deps()).ratifyReference(input, caller);
    },
    async compareRender(input, caller) {
      return createDesignCompareVerbs(await deps()).compareRender(input, caller);
    },
    async getDesignEvidence(input, caller) {
      return createDesignCompareVerbs(await deps()).getDesignEvidence(input, caller);
    },
  };

  installDesignCompareVerbs(harnessSlug, verbs);
}
