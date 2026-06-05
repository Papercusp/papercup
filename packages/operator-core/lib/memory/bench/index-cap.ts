/**
 * File-index cap probe (memory-backend-benchmark-2026-06-05 P-010, D-004).
 *
 * The claude-file backend itself searches TOPIC FILES and never reads
 * `MEMORY.md` — but the real consumption path at session start is the
 * INDEX, an auto-generated projection (`~/.claude/scripts/memory-compact.mjs`,
 * plan fix-claude-code-memory-2026-06-05) with a HARD ~24.4 KB cap (past it
 * Claude silently drops the tail) and a 20 KB soft cap the projector keeps
 * the index under by PHYSICALLY ARCHIVING overflow `project` topic files
 * (oldest first; durable user/feedback/reference entries are never evicted).
 *
 * Two distinct cap consequences this probe records per store size:
 *   1. **Session-start visibility** — only entries that fit in the rendered
 *      index are visible to a booting agent; everything else exists but is
 *      invisible until searched for explicitly.
 *   2. **Post-compaction searchability** — archived files leave the
 *      backend's searchable store entirely (collect() skips archive/), so a
 *      real compaction pass SHRINKS RECALL, not just the index.
 *
 * The simulation mirrors the projector's math exactly (constants, entry
 * line format, section order, eviction passes). Fidelity is pinned by an
 * integration test that runs the REAL script (`--dry-run`) over the same
 * store and compares. The probe seeds temp-dir stores through the seam
 * (D-009 — the live `~/.claude` store is never written).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeFileMemoryBackend, parseTopicFile } from '@papercusp/memory';
import { generateSyntheticCorpus, seedCorpus, type CorpusEntry } from '@papercusp/memory/bench';

// ---- constants mirrored from memory-compact.mjs (defaults, no env) ---------

export const HARD_CAP_KB = 24.4;
export const SOFT_CAP_KB = 20;
export const MAX_ENTRY_CHARS = 140;
const STALE_DAYS = 30;
const DURABLE_TYPES = new Set(['user', 'feedback', 'reference']);
const KNOWN_TYPES = new Set(['user', 'feedback', 'reference', 'project']);
const SECTION_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['user', 'User'],
  ['feedback', 'Feedback'],
  ['reference', 'Reference'],
  // (skills section omitted — bench temp stores have no skills/)
  ['project', 'Projects'],
];

export const DEFAULT_PROJECTOR_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'memory-compact.mjs');

// ---- projection entries (the projector's view of a topic file) -------------

export interface ProjectionEntry {
  file: string;
  name: string;
  /** The picked index hook (frontmatter description or body fallback). */
  description: string;
  type: string;
  mtimeMs: number;
  /** Body text (dedup hashing + weak-description fallback source). */
  body: string;
}

/** Mirror of the projector's weak-description fallback (pickHook). */
const WEAK_DESC_LEN = 40;
export function pickHook(description: string, body: string): string {
  if (description && description.length >= WEAK_DESC_LEN) return description;
  const bodyHook = firstBodyHook(body);
  if (bodyHook.length > (description || '').length) return bodyHook;
  return description || '';
}

function firstBodyHook(body: string): string {
  if (!body) return '';
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
  return line ? stripMarkdown(line) : '';
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a memory dir into projection entries (read-only, projector-shaped). */
export function collectProjectionEntries(memoryDir: string): ProjectionEntry[] {
  const out: ProjectionEntry[] = [];
  for (const d of fs.readdirSync(memoryDir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.md') || d.name === 'MEMORY.md') continue;
    const full = path.join(memoryDir, d.name);
    let text: string;
    let stat: fs.Stats;
    try {
      text = fs.readFileSync(full, 'utf8');
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const tf = parseTopicFile(text);
    const type = KNOWN_TYPES.has(tf.type) ? tf.type : 'project';
    out.push({
      file: d.name,
      name: tf.name || d.name.replace(/\.md$/, ''),
      description: pickHook(tf.description, tf.body),
      type,
      mtimeMs: stat.mtimeMs,
      body: tf.body,
    });
  }
  return out;
}

// ---- the projector's render + eviction math, mirrored ----------------------

function truncate(s: string): string {
  if (!s) return '';
  if (s.length <= MAX_ENTRY_CHARS) return s;
  return s.slice(0, MAX_ENTRY_CHARS - 1).trimEnd() + '…';
}

const PLAN_SLUG_RE = /\b[a-z0-9]+(?:-[a-z0-9]+)*-20\d\d-\d\d-\d\d\b/;
function derivableSignalCount(text: string): number {
  if (!text) return 0;
  const signals = [
    /\bsu-[0-9a-f]{4,}\b/i,
    /\b(DONE|SHIPPED|BUILT|LANDED|COMPLETE|MERGED|FIXED|TESTED)\b/i,
    /\bmig(ration)?\s*\d{2,}\b/i,
    /\b20\d\d-\d\d-\d\d\b/,
    PLAN_SLUG_RE,
    /\b(F-\d|WI-\d|D-\d{2,}|P-\d{2,})/,
    /\b\d+\s*(tests?|specs?)\b/i,
  ];
  return signals.filter((re) => re.test(text)).length;
}

function isEvictable(e: ProjectionEntry): boolean {
  return e.type === 'project' && derivableSignalCount(e.description) >= 2;
}

function render(active: ProjectionEntry[]): string {
  const groups = new Map<string, ProjectionEntry[]>();
  for (const e of active) {
    if (!groups.has(e.type)) groups.set(e.type, []);
    groups.get(e.type)!.push(e);
  }
  for (const list of groups.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('# Memory Index');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by ~/.claude/scripts/memory-compact.mjs — DO NOT EDIT BY HAND.');
  lines.push('     This index is a projection of the topic files in this directory (the source of');
  lines.push('     truth). Edit the topic files; the index is regenerated terse + capped at each');
  lines.push('     session start. Stale/overflow memories move to archive/ (recoverable), never');
  lines.push(`     deleted. Last compacted: ${today}. Plan: fix-claude-code-memory-2026-06-05. -->`);
  lines.push('');
  for (const [type, heading] of SECTION_ORDER) {
    const list = groups.get(type);
    if (!list || !list.length) continue;
    lines.push(`## ${heading}`);
    for (const e of list) lines.push(`- [${e.name}](${e.file}) — ${truncate(e.description)}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function renderSize(active: ProjectionEntry[]): number {
  return Buffer.byteLength(render(active), 'utf8');
}

export interface IndexProjectionResult {
  /** Topic files present in the store (post exact-dup dedup). */
  totalFiles: number;
  /** Entries that survive eviction and land in the rendered index. */
  indexed: number;
  indexBytes: number;
  /** Eviction tallies — these files are PHYSICALLY ARCHIVED by a real run. */
  archivedStale: number;
  archivedOverflow: number;
  durableIndexed: number;
  projectIndexed: number;
  overSoftCap: boolean;
  overHardCap: boolean;
  /** Fraction of the (deduped) store visible from the session-start index. */
  indexedFraction: number;
  /**
   * Files still SEARCHABLE after a real (non-dry-run) compaction pass —
   * archive/ is invisible to the backend's collect(), so this equals
   * `indexed`: the cap bounds recall itself, not just boot visibility.
   */
  searchableAfterCompaction: number;
}

/** Pure mirror of the projector's dedup → evict → render pipeline. */
export function simulateIndexProjection(
  entries: readonly ProjectionEntry[],
  nowMs: number = Date.now(),
): IndexProjectionResult {
  // Exact-dup dedup (projector archives byte-identical bodies, keeps newest).
  // Bench stores have unique bodies; mirrored for fidelity on real stores.
  const byBody = new Map<string, ProjectionEntry>();
  for (const e of entries) {
    const prev = byBody.get(e.body);
    if (!prev || e.mtimeMs > prev.mtimeMs) byBody.set(e.body, e);
  }
  const deduped = [...byBody.values()];

  // (a) STALE: derivable project memories older than STALE_DAYS.
  const stale: ProjectionEntry[] = [];
  let active: ProjectionEntry[] = [];
  for (const e of deduped) {
    const ageDays = (nowMs - e.mtimeMs) / 86400000;
    if (isEvictable(e) && ageDays > STALE_DAYS) stale.push(e);
    else active.push(e);
  }

  const softCapBytes = SOFT_CAP_KB * 1024;
  const overflow: ProjectionEntry[] = [];
  const evict = (victim: ProjectionEntry) => {
    overflow.push(victim);
    active = active.filter((e) => e !== victim);
  };
  // (b) overflow pass 1: derivable project memories, oldest first.
  const evictable = active.filter(isEvictable).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let i = 0;
  while (renderSize(active) > softCapBytes && i < evictable.length) evict(evictable[i++]);
  // (c) overflow pass 2 (safety valve): any remaining project memory, oldest first.
  const fallback = active.filter((e) => e.type === 'project').sort((a, b) => a.mtimeMs - b.mtimeMs);
  let j = 0;
  while (renderSize(active) > softCapBytes && j < fallback.length) evict(fallback[j++]);

  const indexBytes = renderSize(active);
  return {
    totalFiles: deduped.length,
    indexed: active.length,
    indexBytes,
    archivedStale: stale.length,
    archivedOverflow: overflow.length,
    durableIndexed: active.filter((e) => DURABLE_TYPES.has(e.type)).length,
    projectIndexed: active.filter((e) => e.type === 'project').length,
    overSoftCap: indexBytes > softCapBytes,
    overHardCap: indexBytes > HARD_CAP_KB * 1024,
    indexedFraction: deduped.length === 0 ? 1 : active.length / deduped.length,
    searchableAfterCompaction: active.length,
  };
}

// ---- the real projector (cross-validation + opportunistic recording) -------

/**
 * Run the actual memory-compact.mjs in --dry-run over a store and parse its
 * report (`active (indexed): N`, `index size: X KB`). Returns null when the
 * script is missing or its output doesn't parse (CI boxes without ~/.claude).
 */
export function runRealProjectorDryRun(
  memoryDir: string,
  scriptPath: string = DEFAULT_PROJECTOR_SCRIPT,
): { indexed: number; indexKb: number } | null {
  if (!fs.existsSync(scriptPath)) return null;
  const r = spawnSync(process.execPath, [scriptPath, '--dry-run', '--memory-dir', memoryDir], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MEMORY_SOFT_CAP_KB: '', MEMORY_STALE_DAYS: '', MEMORY_MAX_ENTRY_CHARS: '' },
  });
  if (r.error) return null;
  const indexed = /active \(indexed\):\s*(\d+)/.exec(r.stderr ?? '');
  const sizeKb = /index size:\s*([\d.]+) KB/.exec(r.stderr ?? '');
  if (!indexed || !sizeKb) return null;
  return { indexed: Number(indexed[1]), indexKb: Number(sizeKb[1]) };
}

// ---- the probe --------------------------------------------------------------

export interface IndexCapPoint extends IndexProjectionResult {
  /** Total store size this point was measured at (real corpus + synthetic). */
  size: number;
  /** The real script's numbers for the same store, when available. */
  realProjector?: { indexed: number; indexKb: number };
}

export interface IndexCapReport {
  corpusSize: number;
  sizes: number[];
  points: IndexCapPoint[];
  notes: string[];
  markdown: string;
}

export interface IndexCapProbeOptions {
  /** Frozen real corpus (the 111-store baseline). */
  corpus: readonly CorpusEntry[];
  /** TOTAL store sizes beyond the corpus baseline (e.g. [1000, 10000]). */
  sizes: number[];
  syntheticSeed?: number;
  /** Path to memory-compact.mjs; null = skip the real-script cross-record. */
  projectorScript?: string | null;
  log?: (msg: string) => void;
}

/**
 * Seed temp-dir stores at corpus → each size (cumulative, like the bench's
 * scale tier) and record the index projection behavior at every point.
 */
export async function probeIndexCap(opts: IndexCapProbeOptions): Promise<IndexCapReport> {
  const log = opts.log ?? (() => {});
  const seed = opts.syntheticSeed ?? 1337;
  const scriptPath = opts.projectorScript === null ? null : (opts.projectorScript ?? DEFAULT_PROJECTOR_SCRIPT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-index-cap-'));
  const backend = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
  const points: IndexCapPoint[] = [];
  try {
    log(`seeding the ${opts.corpus.length}-entry real corpus…`);
    await seedCorpus(backend, opts.corpus, { scope: 'bench', concurrency: 16 });

    let current = opts.corpus.length;
    const targets = [current, ...[...opts.sizes].sort((a, b) => a - b).filter((s) => s > current)];
    for (const target of targets) {
      const delta = target - current;
      if (delta > 0) {
        log(`seeding ${delta} synthetic distractors → ${target}…`);
        const synthetic = generateSyntheticCorpus(delta, seed + current);
        await seedCorpus(backend, synthetic, { scope: 'bench', concurrency: 16 });
        current = target;
      }
      log(`projecting @${target}…`);
      const sim = simulateIndexProjection(collectProjectionEntries(dir));
      const real = scriptPath ? runRealProjectorDryRun(dir, scriptPath) : null;
      points.push({ size: target, ...sim, ...(real ? { realProjector: real } : {}) });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const notes = buildCapNotes(points);
  return {
    corpusSize: opts.corpus.length,
    sizes: points.map((p) => p.size),
    points,
    notes,
    markdown: renderIndexCapMarkdown(points, notes),
  };
}

function buildCapNotes(points: readonly IndexCapPoint[]): string[] {
  const notes: string[] = [
    `index caps (memory-compact.mjs defaults): soft ${SOFT_CAP_KB} KB (projector evicts to fit), hard ~${HARD_CAP_KB} KB (native Claude limit — past it the tail is silently dropped).`,
    'durable types (user/feedback/reference) are never auto-evicted; only project entries are shed (oldest first).',
    'a real (non-dry-run) compaction PHYSICALLY ARCHIVES evicted files — they leave the backend\'s searchable store, so the cap bounds recall, not just session-start visibility.',
  ];
  const worst = points[points.length - 1];
  if (worst && worst.size > worst.indexed) {
    notes.push(
      `at ${worst.size} entries only ${worst.indexed} (${(worst.indexedFraction * 100).toFixed(1)}%) fit the index; ` +
        `${worst.archivedOverflow} would be archived by one compaction pass.`,
    );
  }
  if (points.some((p) => p.overSoftCap)) {
    notes.push(
      'the durable set alone exceeds the soft cap at some sizes — nothing mechanical left to shed (the projector emits its near-limit hygiene notice; the real store already hit this once).',
    );
  }
  if (points.some((p) => p.overHardCap)) {
    notes.push(
      'post-eviction index STILL over the hard cap at some sizes (durables alone over-cap) — there the real projector ABORTS: archives nothing, leaves MEMORY.md stale, and the session-start reader silently drops the tail of whatever index was last written.',
    );
  }
  return notes;
}

/** One markdown table over the probe points (folds into the bench report). */
export function renderIndexCapMarkdown(points: readonly IndexCapPoint[], notes: readonly string[]): string {
  const lines: string[] = [];
  lines.push('| store size | indexed | index KB | indexed % | archived by compaction | over soft cap | over hard cap | real projector |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of points) {
    lines.push(
      `| ${p.size} | ${p.indexed} (${p.durableIndexed} durable + ${p.projectIndexed} project) | ${(p.indexBytes / 1024).toFixed(1)} | ` +
        `${(p.indexedFraction * 100).toFixed(1)}% | ${p.archivedOverflow + p.archivedStale} | ${p.overSoftCap ? 'YES' : 'no'} | ${p.overHardCap ? 'YES' : 'no'} | ` +
        `${p.realProjector ? `${p.realProjector.indexed} @ ${p.realProjector.indexKb} KB` : '—'} |`,
    );
  }
  lines.push('');
  for (const n of notes) lines.push(`- ${n}`);
  return lines.join('\n');
}
