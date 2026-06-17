/**
 * manage — post-install Learning Pack management
 * (learning-packs-2026-06-11 P-009 install/uninstall/enable/disable,
 * P-010 install-time conflict review, P-013 upgrade).
 *
 * The conflict-review contract (D-003): an install into a NON-EMPTY pool is a
 * MERGE REVIEW, never a silent union. `classifyPackInstall` runs each incoming
 * learning through the same machinery memory:remember uses — semantic top-K
 * search (duplicate when the top hit clears the dedup threshold) + the LLM
 * conflict judge (P-017) — and returns a per-item report with preselected
 * defaults (existing content outranks the incoming pack ⇒ duplicates and
 * conflicts default to 'skip'). `applyPackInstall` then executes explicit
 * per-item resolutions: install · skip · replace (forget the clashing row,
 * write incoming) · keep-both.
 *
 * Enable/disable (P-009): a hive setting (`learning-packs:disabled`, a JSON
 * string[] of pack ids on the federated hive_settings store) the injection
 * path filters against — a disabled pack's rows stay in the store but stop
 * being recalled. Cheap to flip, fully reversible.
 *
 * Upgrade (P-013): adopt a newer pack version's NEW items only (classified
 * like an install). Rows already present are never auto-touched — the store
 * cannot distinguish user edits from pack drift, and never-clobber-user-edits
 * is the D-003 line.
 *
 * Deps are injectable (store, judge, settings) so the review logic pins in
 * unit tests with zero PG/LLM.
 */

import { getMemoryBackend, type MemoryBackend, type MemoryEntry } from '../memory/backend';
import { hiveScopeKey } from '../memory/hive-scope';
import { checkConflicts, type LlmJudge } from '../memory/conflict-check';
import {
  filterByShapes,
  memoryTextOf,
  type AppliesTo,
  type LearningPack,
} from './pack-format';
import { rememberPackItem } from './seed';

/** Same env-tunable threshold family as memory:remember's dedup (P-016). */
function dupThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DEDUP_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.9;
}
const CLASSIFY_TOP_K = 3;
/** Bounded classification concurrency (each item = 1 search + ≤1 judge call). */
const CLASSIFY_CONCURRENCY = 4;

export type InstallAction = 'install' | 'skip' | 'replace' | 'keep-both';

export interface InstallClassification {
  itemId: string;
  title: string;
  /** The canonical text that would be written. */
  incoming: string;
  /**
   * `present` = a row with this `{pack_id, pack_item_id}` already exists
   * (provenance match, embedding-score-independent) — re-install is a no-op,
   * never a duplicate write. clean/duplicate/conflict are the same-pool
   * semantic outcomes for items with no provenance row yet.
   */
  status: 'present' | 'clean' | 'duplicate' | 'conflict';
  /** The clashing existing row (duplicate/conflict only). */
  existing?: { id: string; text: string; organic: boolean; packId?: string; score?: number };
  /** One-line judge summary (conflict only). */
  summary?: string;
  /** Preselected default (D-003: existing outranks incoming ⇒ skip). */
  defaultAction: InstallAction;
}

export interface InstallReview {
  packId: string;
  packVersion: string;
  items: InstallClassification[];
  clean: number;
  duplicates: number;
  conflicts: number;
  /** Items already present by provenance (skipped — no embedding lookup). */
  present: number;
}

export interface ManageDeps {
  backend?: MemoryBackend;
  judge?: LlmJudge;
}

function realJudge(): LlmJudge {
  // Lazy — pulling the Anthropic client at module load would tax every importer.
  return async (input) => {
    const { createAnthropicJudge } = await import('../memory/anthropic-judge');
    return createAnthropicJudge()(input);
  };
}

function packIdOf(e: MemoryEntry): string | undefined {
  const m = e.metadata ?? {};
  return m.source === 'pack' && typeof m.pack_id === 'string' ? m.pack_id : undefined;
}

/**
 * Classify every (shape-filtered) pack item against the hive's current pool.
 * Defensive like the memory write path: a search/judge failure degrades that
 * item to 'clean' (the write path's own posture) rather than blocking install.
 */
export async function classifyPackInstall(
  opts: {
    hiveSlug: string;
    pack: LearningPack;
    shapes?: readonly AppliesTo[];
  },
  deps: ManageDeps = {},
): Promise<InstallReview> {
  const backend = deps.backend ?? getMemoryBackend();
  const judge = deps.judge ?? realJudge();
  const scope = hiveScopeKey(opts.hiveSlug);
  const items = opts.shapes === undefined ? [...opts.pack.items] : filterByShapes(opts.pack.items, opts.shapes);

  // Provenance guard (mirrors planPackUpgrade): an item whose
  // {pack_id, pack_item_id} already has a row is ALREADY PRESENT, regardless
  // of what the embedding search returns. Without this, a re-install where the
  // top neighbor's score dips below dupThreshold would re-classify as 'clean'
  // → 'install' and write a SECOND row with the same pack_item_id (D-003: a
  // pack row is never double-written). The list is read once, not per item.
  let presentItemIds = new Set<string>();
  try {
    const pool = await backend.list({ scope });
    presentItemIds = new Set(
      pool
        .filter((e) => packIdOf(e) === opts.pack.manifest.id)
        .map((e) => (typeof e.metadata?.pack_item_id === 'string' ? e.metadata.pack_item_id : ''))
        .filter(Boolean),
    );
  } catch {
    /* pool unreadable — fall back to search-only classification (no guard) */
  }

  const out: InstallClassification[] = [];
  for (let i = 0; i < items.length; i += CLASSIFY_CONCURRENCY) {
    const batch = items.slice(i, i + CLASSIFY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item): Promise<InstallClassification> => {
        const incoming = memoryTextOf(item);
        const base = { itemId: item.id, title: item.title, incoming };
        if (presentItemIds.has(item.id)) {
          return { ...base, status: 'present', defaultAction: 'skip' };
        }
        try {
          const neighbors = await backend.search(incoming, { scope, limit: CLASSIFY_TOP_K });
          const top = neighbors[0];
          const topScore = typeof top?.score === 'number' ? top.score : null;
          if (top && topScore !== null && topScore >= dupThreshold()) {
            return {
              ...base,
              status: 'duplicate',
              existing: {
                id: top.id,
                text: top.text,
                organic: !packIdOf(top),
                ...(packIdOf(top) ? { packId: packIdOf(top) } : {}),
                score: topScore,
              },
              defaultAction: 'skip',
            };
          }
          if (neighbors.length > 0) {
            const conflict = await checkConflicts({
              newText: incoming,
              neighbors: neighbors.map((n) => ({ id: n.id, text: n.text, score: n.score })),
              judge,
            });
            const hit = conflict.conflicts[0];
            if (hit) {
              const existing = neighbors.find((n) => n.id === hit.memory_id);
              return {
                ...base,
                status: 'conflict',
                ...(existing
                  ? {
                      existing: {
                        id: existing.id,
                        text: existing.text,
                        organic: !packIdOf(existing),
                        ...(packIdOf(existing) ? { packId: packIdOf(existing) } : {}),
                        ...(typeof existing.score === 'number' ? { score: existing.score } : {}),
                      },
                    }
                  : {}),
                summary: hit.summary,
                defaultAction: 'skip',
              };
            }
          }
        } catch {
          /* degraded: classify as clean — same posture as remember's dedup */
        }
        return { ...base, status: 'clean', defaultAction: 'install' };
      }),
    );
    out.push(...results);
  }

  return {
    packId: opts.pack.manifest.id,
    packVersion: opts.pack.manifest.version,
    items: out,
    clean: out.filter((c) => c.status === 'clean').length,
    duplicates: out.filter((c) => c.status === 'duplicate').length,
    conflicts: out.filter((c) => c.status === 'conflict').length,
    present: out.filter((c) => c.status === 'present').length,
  };
}

export interface ApplyInstallResult {
  ok: boolean;
  packId: string;
  packVersion: string;
  installed: number;
  skipped: number;
  replaced: number;
  failed: number;
  error?: string;
}

/**
 * Execute a reviewed install. `resolutions` overrides the classification's
 * defaults per item id; unresolved items take their default. NEVER a silent
 * union: this only runs against a classification (the caller surfaces it).
 */
export async function applyPackInstall(
  opts: {
    workspaceId: string;
    hiveSlug: string;
    pack: LearningPack;
    review: InstallReview;
    resolutions?: ReadonlyArray<{ itemId: string; action: InstallAction }>;
    createdBy?: string;
  },
  deps: ManageDeps = {},
): Promise<ApplyInstallResult> {
  const backend = deps.backend ?? getMemoryBackend();
  const byId = new Map(opts.resolutions?.map((r) => [r.itemId, r.action]) ?? []);
  let installed = 0;
  let skipped = 0;
  let replaced = 0;
  let failed = 0;

  for (const c of opts.review.items) {
    // A provenance-present item is NEVER re-written, even if a resolution asks
    // to install — the row already exists with this pack_item_id (no dupes).
    if (c.status === 'present') {
      skipped += 1;
      continue;
    }
    const action = byId.get(c.itemId) ?? c.defaultAction;
    if (action === 'skip') {
      skipped += 1;
      continue;
    }
    const item = opts.pack.items.find((i) => i.id === c.itemId);
    if (!item) {
      failed += 1;
      continue;
    }
    try {
      if (action === 'replace' && c.existing) {
        await backend.forget(c.existing.id);
        replaced += 1;
      }
      await rememberPackItem({
        workspaceId: opts.workspaceId,
        hiveSlug: opts.hiveSlug,
        pack: opts.pack,
        item,
        ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
      });
      installed += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `[learning-packs] install write failed (${opts.pack.manifest.id}/${c.itemId}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  void import('../sync-sse')
    .then((m) => {
      m.notifySyncInvalidate('learning.hive');
      m.notifySyncInvalidate('learningPacks.list');
    })
    .catch(() => {});

  return {
    ok: failed === 0,
    packId: opts.review.packId,
    packVersion: opts.review.packVersion,
    installed,
    skipped,
    replaced,
    failed,
    ...(failed > 0 ? { error: `${failed} write(s) failed` } : {}),
  };
}

export interface UninstallResult {
  ok: boolean;
  packId: string;
  removed: number;
  /** Edited rows kept (keepEdited, the default) — listed so the caller can report. */
  kept: Array<{ id: string; text: string }>;
}

/**
 * Remove a pack's rows from the hive pool (provenance-driven). Edited rows
 * (text no longer the pack's canonical render) are KEPT by default — they're
 * the user's words now; `keepEdited: false` removes everything.
 */
export async function uninstallPack(
  opts: {
    hiveSlug: string;
    packId: string;
    /** The resolvable pack (for the edited-row comparison); null when gone. */
    pack: LearningPack | null;
    keepEdited?: boolean;
  },
  deps: ManageDeps = {},
): Promise<UninstallResult> {
  const backend = deps.backend ?? getMemoryBackend();
  const keepEdited = opts.keepEdited !== false;
  const entries = await backend.list({ scope: hiveScopeKey(opts.hiveSlug) });
  const mine = entries.filter((e) => packIdOf(e) === opts.packId);

  const kept: Array<{ id: string; text: string }> = [];
  let removed = 0;
  for (const e of mine) {
    const itemId = typeof e.metadata?.pack_item_id === 'string' ? e.metadata.pack_item_id : undefined;
    const item = itemId ? opts.pack?.items.find((i) => i.id === itemId) : undefined;
    const pristine = item ? memoryTextOf(item) === e.text : false;
    if (keepEdited && !pristine) {
      kept.push({ id: e.id, text: e.text });
      continue;
    }
    try {
      await backend.forget(e.id);
      removed += 1;
    } catch {
      /* best-effort; report what we did */
    }
  }

  void import('../sync-sse')
    .then((m) => {
      m.notifySyncInvalidate('learning.hive');
      m.notifySyncInvalidate('learningPacks.list');
    })
    .catch(() => {});

  return { ok: true, packId: opts.packId, removed, kept };
}

/* ────────────────────────────────────────────────────────────────────────
 * Enable / disable (hive_settings-backed)
 * ──────────────────────────────────────────────────────────────────────── */

export const DISABLED_PACKS_SETTING = 'learning-packs:disabled';

export async function disabledPacksFor(workspaceId: string, hiveSlug: string): Promise<string[]> {
  try {
    const { getHiveSetting } = await import('../hive-settings-store');
    const rec = await getHiveSetting(workspaceId, hiveSlug, DISABLED_PACKS_SETTING);
    const v: unknown = rec?.value ?? null; // store JSON-parses the value column
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function setPackEnabled(opts: {
  workspaceId: string;
  hiveSlug: string;
  packId: string;
  enabled: boolean;
}): Promise<{ ok: true; disabled: string[] }> {
  const cur = await disabledPacksFor(opts.workspaceId, opts.hiveSlug);
  const next = opts.enabled ? cur.filter((p) => p !== opts.packId) : [...new Set([...cur, opts.packId])];
  const { setHiveSetting } = await import('../hive-settings-store');
  await setHiveSetting({
    workspaceId: opts.workspaceId,
    hiveHomeSlug: opts.hiveSlug,
    settingKey: DISABLED_PACKS_SETTING,
    value: next, // store serializes JSON values
  });
  void import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.hive'))
    .catch(() => {});
  return { ok: true, disabled: next };
}

/* ────────────────────────────────────────────────────────────────────────
 * Conflict sweep (P-012): re-judge the whole pool on demand
 * ──────────────────────────────────────────────────────────────────────── */

export interface ConflictPair {
  aId: string;
  aText: string;
  bId: string;
  bText: string;
  summary: string;
}

export interface SweepResult {
  hive: string;
  scanned: number;
  pairs: ConflictPair[];
  /** True when the pool exceeded the scan cap and the tail was skipped. */
  capped: boolean;
}

/** Sweep cap — N searches + ≤N judge calls; a huge pool gets a loud partial. */
const SWEEP_MAX_ROWS = 200;

/**
 * Re-run the conflict judge across a hive's whole pool — catches
 * contradictions that EMERGE after install (a pack row vs what the hive
 * organically learned last week), which the write-time check can't see.
 * Read-only: returns the pairs; resolution (forget/update one side) is the
 * caller's deliberate act. Pairs are deduped (a↔b reported once).
 */
export async function sweepHiveConflicts(
  opts: { hiveSlug: string },
  deps: ManageDeps = {},
): Promise<SweepResult> {
  const backend = deps.backend ?? getMemoryBackend();
  const judge = deps.judge ?? realJudge();
  const all = await backend.list({ scope: hiveScopeKey(opts.hiveSlug) });
  const rows = all.slice(0, SWEEP_MAX_ROWS);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const seen = new Set<string>();
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < rows.length; i += CLASSIFY_CONCURRENCY) {
    const batch = rows.slice(i, i + CLASSIFY_CONCURRENCY);
    const found = await Promise.all(
      batch.map(async (row) => {
        try {
          const neighbors = (await backend.search(row.text, { scope: hiveScopeKey(opts.hiveSlug), limit: CLASSIFY_TOP_K + 1 }))
            .filter((n) => n.id !== row.id);
          if (neighbors.length === 0) return [];
          const report = await checkConflicts({
            newText: row.text,
            neighbors: neighbors.map((n) => ({ id: n.id, text: n.text, score: n.score })),
            judge,
          });
          return report.conflicts.map((c) => ({ row, otherId: c.memory_id, summary: c.summary }));
        } catch {
          return []; // degraded — a sweep is hygiene, never load-bearing
        }
      }),
    );
    for (const hits of found) {
      for (const { row, otherId, summary } of hits) {
        const key = [row.id, otherId].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const other = byId.get(otherId);
        pairs.push({
          aId: row.id,
          aText: row.text,
          bId: otherId,
          bText: other?.text ?? '(not in this pool)',
          summary,
        });
      }
    }
  }
  return { hive: opts.hiveSlug, scanned: rows.length, pairs, capped: all.length > rows.length };
}

/* ────────────────────────────────────────────────────────────────────────
 * Upgrade (P-013): adopt a newer pack version's NEW items only
 * ──────────────────────────────────────────────────────────────────────── */

export interface UpgradePlanResult {
  packId: string;
  /** Versions seen on the installed rows (usually one). */
  installedVersions: string[];
  availableVersion: string;
  /** Items in the available pack with no row in the pool — the adoptable set. */
  newItems: InstallReview;
  /** Rows present (never auto-touched — user edits are indistinguishable from pack drift). */
  presentRows: number;
}

export async function planPackUpgrade(
  opts: { hiveSlug: string; pack: LearningPack },
  deps: ManageDeps = {},
): Promise<UpgradePlanResult> {
  const backend = deps.backend ?? getMemoryBackend();
  const entries = await backend.list({ scope: hiveScopeKey(opts.hiveSlug) });
  const mine = entries.filter((e) => packIdOf(e) === opts.pack.manifest.id);
  const presentItemIds = new Set(
    mine.map((e) => (typeof e.metadata?.pack_item_id === 'string' ? e.metadata.pack_item_id : '')).filter(Boolean),
  );
  const missing = opts.pack.items.filter((i) => !presentItemIds.has(i.id));
  const newItems = await classifyPackInstall(
    { hiveSlug: opts.hiveSlug, pack: { ...opts.pack, items: missing } },
    deps,
  );
  return {
    packId: opts.pack.manifest.id,
    installedVersions: [
      ...new Set(
        mine
          .map((e) => (typeof e.metadata?.pack_version === 'string' ? e.metadata.pack_version : ''))
          .filter(Boolean),
      ),
    ],
    availableVersion: opts.pack.manifest.version,
    newItems,
    presentRows: mine.length,
  };
}
