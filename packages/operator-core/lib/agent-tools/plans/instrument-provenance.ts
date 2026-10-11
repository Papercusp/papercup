/**
 * P-010 (verification-system-improvements-2026-10-10; D-010, D-014 §R-10 scope, D-015):
 * measurement-kind evidence must name the instrument that produced it.
 *
 * An `operational` or `manual` binding records a number or an observation that some
 * program measured. When that program is a throwaway script — a `.papercusp/scratch`
 * probe, a `/tmp` file, an uncommitted edit — nobody can re-run it, review it, or notice
 * that it divides by the wrong denominator (the recall@1 incident: an AVG that dropped
 * NULL rows reported a healthy number for a broken instrument). So at BIND TIME the binding
 * must either cite `details.instrument = { path, testPath }` — an instrument file and the
 * test that imports it, BOTH committed blobs — or declare `details.instrument = { none:
 * true, reason }` that it used no instrument at all.
 *
 * Scope rules (each pinned by a clause):
 *  - Only `operational` / `manual` evidence (D-014): test/mutation/check evidence already
 *    names its executable subject.
 *  - BIND TIME ONLY (SPEC-P-010-BIND-TIME-ONLY): this is called from the
 *    plans:bind-spec-evidence handler and nowhere else. Re-measurement of an already-bound
 *    row (a scorecard re-emit, a freshness recompute) never re-judges provenance, so
 *    evidence bound before the rule landed is not retroactively refused.
 *  - The bound commit is the as-committed run's commit when the binding carries one
 *    (SPEC-P-010-AS-COMMITTED), else the checkout's HEAD. The run's recorded ROOT (a
 *    disposable `/tmp` clone) is never consulted — only the instrument's own path is.
 *  - A registered sibling checkout is accepted when it carries an explicit commit pin
 *    (SPEC-P-010-INSTRUMENT-PROVENANCE): its HEAD moves independently of ours, so an
 *    unpinned citation names no reproducible bytes.
 */
import { posix } from 'node:path';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';

export const INSTRUMENT_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['operational', 'manual']);

export const INSTRUMENT_REFUSAL_CODES = [
  'instrument_undeclared',
  'instrument_scratch_probe',
  'instrument_outside_repo',
  'instrument_not_committed',
  'instrument_test_not_importing',
  'instrument_sibling_unpinned',
] as const;
export type InstrumentRefusalCode = (typeof INSTRUMENT_REFUSAL_CODES)[number];

export interface InstrumentProvenanceRefusal {
  error: InstrumentRefusalCode;
  reason: string;
  instrument: unknown;
}

export interface InstrumentProvenanceDeps {
  git: GitRunner;
  /** Absolute root of the harness checkout the binding belongs to. */
  primaryRoot: () => Promise<string>;
  /** Absolute root of a REGISTERED checkout by harness slug; null when the slug is unregistered. */
  checkoutRoot: (checkout: string) => Promise<string | null>;
}

const SCRATCH_PREFIX = '.papercusp/scratch/';
const COMMIT_PIN_RE = /^[0-9a-f]{7,40}$/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const STRIPPABLE_EXT_RE = /\.(d\.ts|[cm]?[jt]sx?)$/;
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g;

const DECLARE_HINT =
  'Cite details.instrument = { path, testPath } — the instrument file and the committed test that imports it, ' +
  'both repository-relative — or declare details.instrument = { none: true, reason: "<why no instrument was used>" }.';

function refusal(error: InstrumentRefusalCode, reason: string, instrument: unknown): InstrumentProvenanceRefusal {
  return { error, reason, instrument: instrument ?? null };
}

function isOutsideRepo(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return posix.normalize(path).split('/').includes('..');
}

function stripExt(path: string): string {
  return path.replace(STRIPPABLE_EXT_RE, '').replace(/\/index$/, '');
}

/**
 * Does the committed test body reference the instrument? A relative import/require that
 * resolves to it, a path-alias import whose tail names it, or the instrument's
 * repo-relative path written as a literal (how a test drives a shell/SQL instrument).
 */
export function testReferencesInstrument(testBody: string, testPath: string, instrumentPath: string): boolean {
  const target = stripExt(posix.normalize(instrumentPath));
  if (testBody.includes(instrumentPath)) return true;
  const testDir = posix.dirname(posix.normalize(testPath));
  for (const match of testBody.matchAll(SPECIFIER_RE)) {
    const spec = match[1]!;
    if (spec.startsWith('.')) {
      if (stripExt(posix.join(testDir, spec)) === target) return true;
      continue;
    }
    const segments = stripExt(spec).split('/').filter(Boolean);
    if (segments.length >= 2 && target.endsWith(`/${segments.slice(-2).join('/')}`)) return true;
  }
  return false;
}

async function blobExists(git: GitRunner, repo: string, commit: string, rel: string): Promise<boolean> {
  try {
    await git(repo, ['cat-file', '-e', `${commit}:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

/** The innermost git repository holding `rel` under `root` (submodules included). */
async function locateRepo(git: GitRunner, root: string, rel: string): Promise<{ repo: string; rel: string }> {
  let dir = posix.dirname(rel);
  while (dir !== '.' && dir !== '/') {
    try {
      const top = (await git(posix.join(root, dir), ['rev-parse', '--show-toplevel'])).trim();
      if (top && top !== root) return { repo: top, rel: posix.relative(top, posix.join(root, rel)) };
      break;
    } catch {
      dir = posix.dirname(dir);
    }
  }
  return { repo: root, rel };
}

export async function instrumentProvenanceRefusal(
  binding: { evidenceKind: string; details?: Record<string, unknown> | undefined },
  asCommitted: { commitSha: string; repoPrefix: string | null } | undefined,
  deps: InstrumentProvenanceDeps,
): Promise<InstrumentProvenanceRefusal | null> {
  if (!INSTRUMENT_EVIDENCE_KINDS.has(binding.evidenceKind)) return null;
  const raw = binding.details?.instrument;
  const kind = binding.evidenceKind;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refusal('instrument_undeclared', `${kind} evidence names no instrument. ${DECLARE_HINT}`, raw);
  }
  const instrument = raw as Record<string, unknown>;
  if (instrument.none === true) {
    const reason = typeof instrument.reason === 'string' ? instrument.reason.trim() : '';
    if (instrument.path !== undefined || instrument.testPath !== undefined) {
      return refusal('instrument_undeclared', `details.instrument declares none:true AND cites a path; pick one. ${DECLARE_HINT}`, raw);
    }
    if (!reason) {
      return refusal('instrument_undeclared', `details.instrument = { none: true } needs a non-empty reason. ${DECLARE_HINT}`, raw);
    }
    return null;
  }
  const path = typeof instrument.path === 'string' ? instrument.path.trim() : '';
  const testPath = typeof instrument.testPath === 'string' ? instrument.testPath.trim() : '';
  if (!path || !testPath) {
    return refusal(
      'instrument_undeclared',
      `details.instrument must carry both path and testPath (got path=${JSON.stringify(path || null)}, testPath=${JSON.stringify(testPath || null)}). ${DECLARE_HINT}`,
      raw,
    );
  }
  for (const [field, value] of [['path', path], ['testPath', testPath]] as const) {
    if (isOutsideRepo(value)) {
      return refusal(
        'instrument_outside_repo',
        `details.instrument.${field} "${value}" is not a repository-relative path inside the checkout (absolute, /tmp, ~ or ../ paths cannot be re-run by anyone else). ` +
          'Commit the instrument into the repository and cite its repo-relative path; for a registered sibling checkout pass checkout + commitPin.',
        raw,
      );
    }
    if (posix.normalize(value).startsWith(SCRATCH_PREFIX)) {
      return refusal(
        'instrument_scratch_probe',
        `details.instrument.${field} "${value}" is a .papercusp/scratch probe — gitignored, untested and invisible to review. ` +
          "Promote it: move the measuring code into a committed module, cover it with a test in the project's real suite (e.g. <package>/lib/**/<name>.test.ts), then cite that path and test.",
        raw,
      );
    }
  }
  const checkout = typeof instrument.checkout === 'string' ? instrument.checkout.trim() : '';
  const commitPin = typeof instrument.commitPin === 'string' ? instrument.commitPin.trim() : '';
  let repoTarget: { repo: string; rel: string; testRel: string; commit: string };
  if (checkout) {
    const root = await deps.checkoutRoot(checkout);
    if (!root) {
      return refusal(
        'instrument_outside_repo',
        `details.instrument.checkout "${checkout}" is not a registered harness checkout in this workspace, so its bytes cannot be resolved. Cite a registered checkout's harness slug.`,
        raw,
      );
    }
    if (!COMMIT_PIN_RE.test(commitPin)) {
      return refusal(
        'instrument_sibling_unpinned',
        `details.instrument cites sibling checkout "${checkout}" without a commitPin (a 7–40 hex commit sha). A sibling's HEAD moves independently, so record the commit the instrument ran at.`,
        raw,
      );
    }
    repoTarget = { repo: root, rel: path, testRel: testPath, commit: commitPin };
  } else {
    const root = await deps.primaryRoot();
    if (asCommitted) {
      const sub = (asCommitted.repoPrefix ?? '').replace(/\/+$/, '');
      const prefix = sub ? `${sub}/` : '';
      const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
      repoTarget = {
        repo: prefix && path.startsWith(prefix) ? posix.join(root, sub) : root,
        rel: strip(path),
        testRel: strip(testPath),
        commit: asCommitted.commitSha,
      };
    } else {
      const located = await locateRepo(deps.git, root, path);
      const locatedTest = await locateRepo(deps.git, root, testPath);
      if (located.repo !== locatedTest.repo) {
        return refusal(
          'instrument_test_not_importing',
          `details.instrument.path and testPath live in different repositories (${located.repo} vs ${locatedTest.repo}); the importing test must sit beside its instrument.`,
          raw,
        );
      }
      repoTarget = { repo: located.repo, rel: located.rel, testRel: locatedTest.rel, commit: 'HEAD' };
    }
  }
  const { repo, rel, testRel, commit } = repoTarget;
  for (const [field, value] of [['path', rel], ['testPath', testRel]] as const) {
    if (!(await blobExists(deps.git, repo, commit, value))) {
      return refusal(
        'instrument_not_committed',
        `details.instrument.${field} "${value}" is not a committed blob at ${commit} in ${repo}. ` +
          'Leave the file in the shared tree until git-sync commits it (dev:pipeline_position shows when), then bind.',
        raw,
      );
    }
  }
  if (rel === testRel) {
    if (TEST_FILE_RE.test(rel)) return null;
    return refusal(
      'instrument_test_not_importing',
      `details.instrument.testPath equals path, but "${rel}" is not a test file. Cite the test that imports the instrument.`,
      raw,
    );
  }
  let body: string;
  try {
    body = await deps.git(repo, ['show', `${commit}:${testRel}`]);
  } catch {
    return refusal('instrument_not_committed', `details.instrument.testPath "${testRel}" could not be read at ${commit}.`, raw);
  }
  if (!testReferencesInstrument(body, testRel, rel)) {
    return refusal(
      'instrument_test_not_importing',
      `The committed test "${testRel}" does not import or reference the instrument "${rel}". ` +
        'An instrument is tested only by a test that exercises it — import it there (or cite the test that does).',
      raw,
    );
  }
  return null;
}

/** Production wiring: the bound harness root and the registry's checkouts, resolved once per call. */
export function defaultInstrumentProvenanceDeps(
  resolveWorkspaceId: () => Promise<string>,
  harnessSlug: string,
): InstrumentProvenanceDeps {
  let registry: Promise<Awaited<ReturnType<typeof loadHarnessRegistry>>> | undefined;
  const load = () => (registry ??= resolveWorkspaceId().then((workspaceId) => loadHarnessRegistry(workspaceId)));
  return {
    git: defaultGitRunner,
    primaryRoot: async () => {
      const root = resolveHarnessContentPath(await load(), harnessSlug);
      if (!root) throw new Error(`instrument_provenance_root_unavailable:${harnessSlug}`);
      return root;
    },
    checkoutRoot: async (checkout) => resolveHarnessContentPath(await load(), checkout) ?? null,
  };
}
