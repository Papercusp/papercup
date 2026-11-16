/**
 * Failure diagnostics for the native-ecosystem.e2e journeys (EI-28979239714036612).
 *
 * The journeys hash live repo sources and bundle the host handler from the shared working
 * tree, so two failures used to be opaque:
 *  - a concurrent edit to a hashed source during a run failed as a bare 26-key deep-equal,
 *    which reads like a product defect;
 *  - a failed host bundle lost esbuild's own error, because bundle-host.sh writes it to
 *    `<OUTFILE>.build-error.log` inside a temp dir that the suite's afterAll deletes.
 * These helpers name the drift and surface (and keep) the bundle evidence instead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface SourceDrift {
  path: string;
  /** sha256 before the run; null when the path was not hashed before. */
  before: string | null;
  /** sha256 after; null when the path is no longer hashed. */
  after: string | null;
}

/** Every path whose hash changed, appeared or disappeared, sorted by path. */
export function diffSourceHashes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): SourceDrift[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(path => before[path] !== after[path])
    .map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
}

export interface SourceDriftContext {
  /** When the drift was observed, e.g. "during the first-touch journey". */
  stage: string;
  /** Repo-relative path of the test file, used in the as-committed re-run hint. */
  testFile: string;
}

const shortHash = (hash: string | null) => (hash === null ? '(absent)' : hash.slice(0, 12));

/**
 * A failure message that names every drifted source and how to get a real verdict, or ''
 * when nothing drifted. Every drifted path is listed: the list is the evidence.
 */
export function formatSourceDrift(drift: readonly SourceDrift[], context: SourceDriftContext): string {
  if (drift.length === 0) return '';
  return [
    `Live-tree source drift ${context.stage}: ${drift.length} hashed journey source(s) changed while this run ` +
      'was in progress, most likely a concurrent edit to the shared tree. This failure is not a product verdict.',
    ...drift.map(entry => `  ${entry.path}: ${shortHash(entry.before)} -> ${shortHash(entry.after)}`),
    'For a verdict, run the committed tree: node scripts/lint-as-committed.mjs test:file --any --ref=<sha> -- ' +
      `${context.testFile} --testNamePattern=<journey test name>`,
  ].join('\n');
}

/** Logs bundle-host.sh writes beside OUTFILE; esbuild's own output goes to build-error.log. */
export const HOST_BUNDLE_LOG_SUFFIXES = ['.build-error.log', '.restricted-hold-gate.log'] as const;
/** bundle-host.sh's step journal (`$OUTFILE.build-steps.jsonl`, see bundle_host_run_step). */
export const HOST_BUNDLE_JOURNAL_SUFFIX = '.build-steps.jsonl';

/**
 * Steps whose `end` row carries a non-zero status in a bundle-host.sh step journal. Rows that
 * do not parse (for example a row torn by a killed writer) are counted, not dropped silently.
 */
export function failedBundleSteps(journalText: string): { failed: string[]; unparseable: number } {
  const failed: string[] = [];
  let unparseable = 0;
  for (const line of journalText.split('\n')) {
    if (!line.trim()) continue;
    let row: { event?: unknown; step?: unknown; status?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      unparseable += 1;
      continue;
    }
    if (row?.event === 'end' && row.status !== 0) failed.push(`${String(row.step)} (status ${String(row.status)})`);
  }
  return { failed, unparseable };
}

const ERROR_LINE = /\[ERROR\]|\berror\b|✘|🚨/i;
const MAX_LINE_CHARS = 500;
const clip = (line: string) =>
  line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}… [+${line.length - MAX_LINE_CHARS} chars]`;

/**
 * A bounded excerpt of a log: its first error lines (a compiler error usually comes early,
 * where a tail-only cut loses it) plus its tail. Every omission is counted in the excerpt;
 * the full file stays wherever the caller retained it.
 */
export function logExcerpt(text: string, options: { maxErrorLines?: number; tailLines?: number } = {}): string {
  const maxErrorLines = options.maxErrorLines ?? 20;
  const tailLines = options.tailLines ?? 20;
  const lines = text.replace(/\n+$/, '').split('\n');
  const errorLines = lines.filter(line => ERROR_LINE.test(line));
  const parts: string[] = [];
  if (errorLines.length > 0) {
    const shown = errorLines.slice(0, maxErrorLines);
    parts.push(`error lines (${shown.length} of ${errorLines.length}):`, ...shown.map(clip));
    if (errorLines.length > shown.length) parts.push(`  … ${errorLines.length - shown.length} more error line(s) omitted`);
  }
  const tail = lines.slice(-tailLines);
  parts.push(`last ${tail.length} of ${lines.length} line(s):`, ...tail.map(clip));
  return parts.join('\n');
}

/**
 * Copy a failed bundle's logs and step journal into the run's artifact dir, where they outlive
 * temp-dir cleanup. Returns the copy's directory, or null without an artifact dir or evidence.
 */
export function copyHostBundleEvidence(handlerPath: string, artifactDir: string | undefined): string | null {
  const files = [...HOST_BUNDLE_LOG_SUFFIXES, HOST_BUNDLE_JOURNAL_SUFFIX]
    .map(suffix => handlerPath + suffix)
    .filter(file => existsSync(file));
  if (!artifactDir || files.length === 0) return null;
  const target = join(artifactDir, `native-host-bundle-${basename(dirname(handlerPath))}`);
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(file, join(target, basename(file)));
  return target;
}

/** Describe a failed host bundle from the files bundle-host.sh left beside handlerPath. */
export function hostBundleFailureEvidence(handlerPath: string, retainedAt: readonly string[]): string {
  const sections: string[] = [];
  for (const suffix of HOST_BUNDLE_LOG_SUFFIXES) {
    const file = handlerPath + suffix;
    sections.push(existsSync(file)
      ? `${basename(file)}:\n${logExcerpt(readFileSync(file, 'utf8'))}`
      : `${basename(file)}: not written`);
  }
  const journal = handlerPath + HOST_BUNDLE_JOURNAL_SUFFIX;
  if (existsSync(journal)) {
    const { failed, unparseable } = failedBundleSteps(readFileSync(journal, 'utf8'));
    sections.push(`failed bundle steps: ${failed.length > 0 ? failed.join(', ') : 'none recorded'}` +
      (unparseable > 0 ? ` (${unparseable} unparseable journal row(s))` : ''));
  } else {
    sections.push(`${basename(journal)}: not written`);
  }
  sections.push(retainedAt.length > 0
    ? `full bundle evidence retained at: ${retainedAt.join(', ')}`
    : 'bundle evidence was not retained');
  return sections.join('\n');
}
