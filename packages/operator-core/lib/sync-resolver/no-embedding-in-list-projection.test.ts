// Guard: no sync-resolver list query may `SELECT *` a view that carries an
// `embedding` (pgvector) or `_search` (tsvector) column.
//
// THE CLASS THIS DETECTS (whole-app-sync-payload-audit-2026-07-19):
// a resolver that does a bare `.select()` on a consolidated view ships EVERY
// column to the browser, including the search-index internals no component
// renders. Measured on `featuresConsolidated.byHive`: 14,688 rows × a 384-dim
// `embedding` vector = **6.1MB** (+ 0.95MB `_search`) parsed into the webview on
// every HiveContentPanel load. An embedding vector and a tsvector are, by
// construction, never display data.
//
// This is a RECURRING regression, which is why it needs a guard: WI-5412 added
// a slim projection to `featuresConsolidated.bySlug` but its cross-member twin
// `.byHive` kept the bare `.select()` and shipped the vectors for months. A
// per-query fix does not stop the next `.select()` from re-introducing it.
//
// FIX PATTERN when this fails: replace the bare `.select()` with an explicit
// `.select({ … })` of the columns the consuming panel renders (see
// `featuresConsolidated.bySlug` for the model). Row count is unchanged, so
// client-side search/count still see every row — only the unrendered heavy
// columns leave the wire.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OPERATOR_CORE = resolve(__dirname, '../..');
const RESOLVER = resolve(__dirname, 'index.ts');
const GENERATED = resolve(OPERATOR_CORE, '../../libs/papercusp/libs/db/src/schema/generated.ts');

/** Strip block + line comments so a `.select()` quoted in a doc comment is not a hit. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Derive the set of drizzle view/table consts that map an `embedding` (pgvector)
 * or `_search` (tsvector) column, straight from the generated schema — so a NEW
 * heavy view is covered automatically, without editing this test.
 */
function heavyViews(): Set<string> {
  const src = readFileSync(GENERATED, 'utf8');
  const parts = src.split(/(export const \w+ = harnessShared\.(?:view|table)\()/);
  const heavy = new Set<string>();
  for (let i = 1; i < parts.length; i += 2) {
    const name = /export const (\w+)/.exec(parts[i])?.[1];
    const body = parts[i + 1]?.slice(0, 8000) ?? '';
    if (!name) continue;
    if (/embedding:\s*vector/.test(body) || /tsvectorCustom\("_search"\)/.test(body) || /\bsearch:\s*tsvector/.test(body)) {
      heavy.add(name);
    }
  }
  return heavy;
}

/**
 * KNOWN, not-yet-fixed offenders. SHRINK-ONLY, mirroring the KNOWN_DARK_FLAGS /
 * no-heavy-io-on-read-path convention: the high-watermark assertion below fails
 * if this grows, so a new bare `.select()` on a heavy view cannot be quietly
 * appended — the only sanctioned direction is fixing one and deleting its line.
 */
const KNOWN_OFFENDERS = new Set<string>([
  // auditLog.operatorDecisions — bare .select() on auditLog (_search tsvector).
  // Low-impact (capped at 500 rows, actor-filtered), tracked in the payload plan.
  'auditLog.operatorDecisions',
]);
const KNOWN_OFFENDER_HIGH_WATERMARK = 1;

function bareSelectOnHeavyView(): string[] {
  const heavy = heavyViews();
  const src = readFileSync(RESOLVER, 'utf8');
  const starts = [...src.matchAll(/^ {2}'([a-zA-Z]+\.[a-zA-Z]+)':\s*\{/gm)].map((m) => [m[1], m.index!] as const);
  const hits: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const [name, pos] = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1][1] : src.length;
    const block = stripComments(src.slice(pos, end));
    const refs = new Set([...block.matchAll(/generated\.(\w+)/g)].map((m) => m[1]));
    const usesHeavy = [...refs].some((r) => heavy.has(r));
    if (usesHeavy && /\.select\(\s*\)/.test(block)) hits.push(name);
  }
  return hits;
}

describe('no embedding/_search vector leaks into a sync list projection', () => {
  it('the schema actually has heavy views to guard (sanity)', () => {
    // If this ever hits 0 the derivation broke and the guard is silently vacuous.
    expect(heavyViews().size).toBeGreaterThan(5);
  });

  it('no NEW resolver SELECT-*s a view carrying an embedding/_search column', () => {
    const newHits = bareSelectOnHeavyView().filter((n) => !KNOWN_OFFENDERS.has(n));
    expect(
      newHits.length,
      `A sync resolver does a bare .select() on a view that carries an embedding (pgvector) or _search (tsvector)\n` +
        `column — it ships those search-index internals to the browser on every list load (measured 6.1MB on\n` +
        `featuresConsolidated.byHive). Replace with an explicit .select({ … }) of the rendered columns (see\n` +
        `featuresConsolidated.bySlug). Do NOT add to KNOWN_OFFENDERS unless there is a tracked reason.\n` +
        `New offenders: ${newHits.join(', ')}`,
    ).toBe(0);
  });

  it('the known-offender baseline only shrinks (shrink-only high-watermark)', () => {
    expect(
      KNOWN_OFFENDERS.size,
      `The known-offender baseline GREW. A new bare .select() on a heavy view was baselined instead of fixed.`,
    ).toBeLessThanOrEqual(KNOWN_OFFENDER_HIGH_WATERMARK);
  });

  it('every known offender still actually offends — a stale baseline means the guard stopped guarding', () => {
    const actual = new Set(bareSelectOnHeavyView());
    for (const known of KNOWN_OFFENDERS) {
      expect(actual.has(known), `KNOWN_OFFENDERS lists ${known}, but it no longer bare-selects a heavy view — remove it`).toBe(
        true,
      );
    }
  });
});
