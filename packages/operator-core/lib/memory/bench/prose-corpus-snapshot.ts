/**
 * Snapshot the live prose surfaces into a frozen benchmark corpus
 * (prose-embedding-384-untrained-mrl-fix-2026-08-02 P-001).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/prose-corpus-snapshot.ts [--version v1] [--seed <s>]
 *
 * Read-only against Postgres. Sampling is CLUSTER-preserving — see the long
 * rationale in `prose-corpus.ts`: whole doc pages, whole sessions, whole
 * plans, so the sibling near-duplicates that make prose retrieval hard
 * survive into the sample.
 *
 * Deliberately a snapshot-to-fixture step rather than a live query at eval
 * time: the gold set's expected keys bind to a corpus VERSION, and a corpus
 * that shifts under the gold set silently invalidates every stored score.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import type { CorpusEntry } from '@papercusp/memory/bench';

import {
  PROSE_CORPUS_FIXTURE_VERSION,
  PROSE_CORPUS_QUOTAS,
  pickClusters,
  proseCorpusKey,
  writeProseCorpusFixture,
  type ClusterCandidate,
  type ProseCorpusFixture,
} from './prose-corpus';
import {
  DEFAULT_IDENTITY_PLACEHOLDER,
  IDENTITY_LITERAL_PLACEHOLDER,
  scrubProseIdentity,
  type IdentityLiteralRule,
} from './prose-identity-scrub';

/** Same 2000-char cap the live embed-backfill sweep submits (EI-12967). */
const EMBED_CHAR_CAP = 2000;
const cap = (s: string): string => (s.length > EMBED_CHAR_CAP ? s.slice(0, EMBED_CHAR_CAP) : s);

/**
 * The identity detectors the gate lints run, imported at RUNTIME (WI-6994).
 *
 * A dynamic specifier keeps this repo-root `.mjs` out of the package's build
 * graph while still giving the scrub the detector's OWN match rule for class-3
 * literals — the same idiom `pretooluse-content-lint-identity.test.ts` uses to
 * bind a TS consumer to these detectors instead of copying their regexes.
 */
const DETECTOR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/lib/identity-leak-patterns.mjs',
);

interface IdentityDetector {
  resolveIdentityLiterals(): Record<string, string>;
  literalPattern(lit: string): RegExp;
}

/**
 * Build the class-3 rewrites for THIS box.
 *
 * Resolves nothing itself: the account/hostname/git identity comes from the
 * detector, so the scrub hunts exactly what the lint hunts. On a bare/CI box
 * this resolves to `{}` and the scrub degrades to a no-op for this class —
 * expected, not a bug (the box that matters is the one that generates a corpus).
 */
async function buildLiteralRules(): Promise<IdentityLiteralRule[]> {
  try {
    const detector = (await import(DETECTOR)) as IdentityDetector;
    return Object.entries(detector.resolveIdentityLiterals()).map(([key, lit]) => ({
      key,
      // The detector's pattern is single-match; a scrub must rewrite EVERY
      // occurrence, so re-emit it with the global flag and nothing else changed.
      rx: new RegExp(detector.literalPattern(lit).source, `${detector.literalPattern(lit).flags}g`),
      replacement: IDENTITY_LITERAL_PLACEHOLDER[key] ?? DEFAULT_IDENTITY_PLACEHOLDER,
    }));
  } catch (e) {
    // Fail LOUD: silently skipping the scrub is how the leak shipped in the first
    // place. Home-path + owner-tag scrubbing still applies; this class does not.
    console.error(
      `[scrub] WARNING: could not load identity detectors at ${DETECTOR} — ` +
        `class-3 box literals will NOT be scrubbed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const version = argValue('--version') ?? PROSE_CORPUS_FIXTURE_VERSION;
  const seed = argValue('--seed') ?? `prose-corpus-${version}`;

  // Connect DIRECT rather than through the shared org pool: a multi-minute
  // batch snapshot should not occupy a pooler slot the live operator needs.
  // `longLivedPoolConnectionOptions` documents the same direct-connect rule
  // for the same reason.
  const sql = postgres(getHarnessAdminUrl(), {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    onnotice: () => {},
  });


  const entries: CorpusEntry[] = [];
  const bySurface: Record<string, number> = {};
  const clustersBySurface: Record<string, number> = {};

  // WI-6994. Every surface below is a CARRY surface, where `[owner:<Name>]` and
  // absolute home paths are correct — and this fixture is COMMITTED to shipped
  // source, where they are the WI-4776 leak that red-pinned the gate on
  // 2026-08-02. Scrub applies to `text`/`description` only: the gold set binds to
  // KEYS, so rewriting one would silently invalidate every stored score.
  const literalRules = await buildLiteralRules();
  console.log(
    `[scrub] identity scrub active (home paths + owner-name tags + ` +
      `${literalRules.length} box literal(s): ${literalRules.map((r) => r.key).join(', ') || 'none'})`,
  );
  // Applied AFTER `cap`, mirroring buildFixture's "scrub after sampling" rule:
  // selection stays a pure function of the raw surface, and the scrub only
  // rewrites the bytes that actually get committed.
  const scrub = (s: string): string => scrubProseIdentity(s, { literalRules });

  const quotaFor = (s: 'doc' | 'turn' | 'plan') => {
    const q = PROSE_CORPUS_QUOTAS.find((x) => x.surface === s);
    if (!q) throw new Error(`no quota declared for surface '${s}'`);
    return q;
  };

  // ---- doc_sections: cluster = one documentation PAGE (source_key + slug) ----
  {
    console.log('[doc] grouping pages…');
    const q = quotaFor('doc');
    const pages = (await sql`
      SELECT source_key || ' ' || slug AS key, count(*)::int AS size
      FROM harness_shared.doc_sections
      WHERE content IS NOT NULL AND length(content) > 0
      GROUP BY 1
    `) as unknown as ClusterCandidate[];
    const picked = pickClusters(pages, q.budget, q.maxClusterRows, seed);
    const chosen = new Set(picked.keys);
    console.log(`[doc] ${pages.length} pages -> picked ${picked.keys.length} (~${picked.rows} rows); fetching…`);

    const rows = (await sql`
      SELECT source_key, slug, anchor, title, content
      FROM harness_shared.doc_sections
      WHERE content IS NOT NULL AND length(content) > 0
      ORDER BY source_key, slug, anchor
    `) as unknown as Array<{
      source_key: string;
      slug: string;
      anchor: string;
      title: string | null;
      content: string;
    }>;

    const perCluster = new Map<string, number>();
    for (const r of rows) {
      const ckey = `${r.source_key} ${r.slug}`;
      if (!chosen.has(ckey)) continue;
      const n = perCluster.get(ckey) ?? 0;
      if (n >= q.maxClusterRows) continue;
      perCluster.set(ckey, n + 1);
      entries.push({
        key: proseCorpusKey('doc', [r.source_key, r.slug, r.anchor]),
        text: scrub(cap(`${r.title ?? ''}\n${r.content}`)),
        kind: 'doc',
        ...(r.title ? { description: scrub(r.title) } : {}),
        metadata: { surface: 'doc_sections', cluster: ckey },
      });
    }
    bySurface.doc = entries.length;
    clustersBySurface.doc = perCluster.size;
  }

  // ---- session_turns: cluster = one SESSION ----
  {
    console.log('[turn] grouping sessions…');
    const q = quotaFor('turn');
    const before = entries.length;
    const sessions = (await sql`
      SELECT source_kind || ' ' || session_id AS key, count(*)::int AS size
      FROM harness_shared.session_turns
      WHERE length(text) >= 80
      GROUP BY 1
      HAVING count(*) >= 5
    `) as unknown as ClusterCandidate[];
    const picked = pickClusters(sessions, q.budget, q.maxClusterRows, seed);
    console.log(`[turn] ${sessions.length} sessions -> picked ${picked.keys.length} (~${picked.rows} rows); fetching…`);

    const perCluster = new Map<string, number>();
    for (const ckey of picked.keys) {
      const [sourceKind, sessionId] = ckey.split(' ');
      const rows = (await sql`
        SELECT workspace_id, source_kind, session_id, turn_idx, speaker, text
        FROM harness_shared.session_turns
        WHERE source_kind = ${sourceKind} AND session_id = ${sessionId} AND length(text) >= 80
        ORDER BY turn_idx
        LIMIT ${q.maxClusterRows}
      `) as unknown as Array<{
        workspace_id: string;
        source_kind: string;
        session_id: string;
        turn_idx: number;
        speaker: string;
        text: string;
      }>;
      if (rows.length === 0) continue;
      perCluster.set(ckey, rows.length);
      for (const r of rows) {
        entries.push({
          key: proseCorpusKey('turn', [r.source_kind, r.session_id, String(r.turn_idx)]),
          text: scrub(cap(r.text)),
          kind: 'turn',
          description: `${r.speaker} turn ${r.turn_idx}`,
          metadata: { surface: 'session_turns', cluster: ckey, speaker: r.speaker },
        });
      }
    }
    bySurface.turn = entries.length - before;
    clustersBySurface.turn = perCluster.size;
  }

  // ---- harness_plans: cluster = one PLAN (a plan is a single row) ----
  {
    console.log('[plan] listing plans…');
    const q = quotaFor('plan');
    const before = entries.length;
    const plans = (await sql`
      SELECT workspace_id || ' ' || harness_slug || ' ' || plan_slug AS key, 1::int AS size
      FROM harness_shared.harness_plans
      WHERE content IS NOT NULL AND length(content) > 0
    `) as unknown as ClusterCandidate[];
    const picked = pickClusters(plans, q.budget, q.maxClusterRows, seed);
    const chosen = new Set(picked.keys);

    const rows = (await sql`
      SELECT workspace_id, harness_slug, plan_slug, title, content
      FROM harness_shared.harness_plans
      WHERE content IS NOT NULL AND length(content) > 0
      ORDER BY workspace_id, harness_slug, plan_slug
    `) as unknown as Array<{
      workspace_id: string;
      harness_slug: string;
      plan_slug: string;
      title: string | null;
      content: string;
    }>;
    for (const r of rows) {
      const ckey = `${r.workspace_id} ${r.harness_slug} ${r.plan_slug}`;
      if (!chosen.has(ckey)) continue;
      entries.push({
        key: proseCorpusKey('plan', [r.workspace_id, r.harness_slug, r.plan_slug]),
        text: scrub(cap(`${r.title ?? ''}\n${r.content}`)),
        kind: 'plan',
        ...(r.title ? { description: scrub(r.title) } : {}),
        metadata: { surface: 'harness_plans', cluster: ckey },
      });
    }
    bySurface.plan = entries.length - before;
    clustersBySurface.plan = entries.length - before;
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  const fixture: ProseCorpusFixture = {
    version,
    snapshotAt: new Date().toISOString(),
    count: entries.length,
    bySurface,
    clustersBySurface,
    seed,
    note:
      'Prose-surface benchmark corpus (prose-embedding-384-untrained-mrl-fix P-001). ' +
      'CLUSTER-preserving sample: whole doc pages / sessions / plans, so sibling ' +
      'near-duplicates (the hard part of prose retrieval) survive into the sample. ' +
      'Gold-set expected keys bind to THIS version — regenerate both together, never in place.',
    entries,
  };

  const file = writeProseCorpusFixture(fixture);
  console.log(`wrote ${file}`);
  console.log(`  count=${fixture.count} bySurface=${JSON.stringify(bySurface)}`);
  console.log(`  clusters=${JSON.stringify(clustersBySurface)} seed=${seed}`);
  const chars = entries.reduce((s, e) => s + e.text.length, 0);
  console.log(`  mean chars/entry=${Math.round(chars / Math.max(entries.length, 1))}`);
  console.log(`  est. embed time @353ms/doc = ${((entries.length * 0.353) / 60).toFixed(1)} min per model pass`);
  process.exit(0);
}

void main().catch((e) => {
  console.error('prose-corpus-snapshot failed:', e instanceof Error ? e.message : e);
  if (e instanceof Error) {
    console.error('stack:', e.stack);
    for (const k of ['code', 'severity', 'detail', 'hint', 'where', 'query', 'position'] as const) {
      const v = (e as unknown as Record<string, unknown>)[k];
      if (v !== undefined) console.error(`  ${k}:`, String(v).slice(0, 400));
    }
    if ((e as { cause?: unknown }).cause) console.error('  cause:', (e as { cause?: unknown }).cause);
  }
  process.exit(1);
});
