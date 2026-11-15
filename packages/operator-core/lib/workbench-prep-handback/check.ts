/**
 * Maintained operational checker for a Workbench platform-preparation HANDBACK
 * (WI-6554700010049420; plan quick-access-search-launcher-2026-10-26, clause
 * PREP-UBUNTU@2, scenarios `workbench.prep.ubuntu.source-identity-handoff` and
 * `workbench.prep.ubuntu.unverified-installed-boundary`).
 *
 * A preparation item hands a downstream item (P-006 -> P-002) a set of source
 * identities plus the checks it deliberately did NOT perform. The prose handback
 * cannot be verified mechanically, so the handback is a structured JSON document
 * and this module verifies it against Git and the test-run ledger. It never parses
 * prose: every judged value is a typed field.
 *
 * Pure: every external read goes through `PrepHandbackDeps`, so the Vitest suite
 * drives the real logic with invalid fixtures and `run.ts` supplies Git + Postgres.
 */

export const SOURCE_IDENTITY_CASE = 'workbench.prep.ubuntu.source-identity-handoff';
export const INSTALLED_BOUNDARY_CASE = 'workbench.prep.ubuntu.unverified-installed-boundary';
export const PREP_HANDBACK_KIND = 'workbench-prep-handback';
export const REQUIRED_SEQUENCE = ['P-001', 'P-002', 'P-003'] as const;
export const UNRESOLVED_STATUS = 'unresolved';

export type UnresolvedScope = 'source-runtime' | 'installed-candidate';

/**
 * The checks a Ubuntu preparation handback MUST retain as unresolved. Mirrors
 * the retained obligations of the original P-006 handback (coord post 1229390):
 * the accepted source/runtime binding stays P-001's, and every installed check
 * is P-002's on the exact candidate. Adding an obligation is a code change here,
 * reviewed with its test, never something a handback can opt out of.
 */
export const REQUIRED_UNRESOLVED_CHECKS: ReadonlyArray<{ id: string; scope: UnresolvedScope }> = [
  { id: 'source-runtime.accepted-binding', scope: 'source-runtime' },
  { id: 'source-runtime.running-operator-contains-change', scope: 'source-runtime' },
  { id: 'installed.candidate-artifact-identity', scope: 'installed-candidate' },
  { id: 'installed.fresh-install-upgrade-login-restart', scope: 'installed-candidate' },
  { id: 'installed.resident-shortcut-native-surfaces', scope: 'installed-candidate' },
  { id: 'installed.invalid-pui-guard', scope: 'installed-candidate' },
  { id: 'installed.helper-eof-reconnect-isolation', scope: 'installed-candidate' },
  { id: 'installed.vendor-input-canonical-flows', scope: 'installed-candidate' },
  { id: 'installed.d015-pui-zellij-terminal', scope: 'installed-candidate' },
  { id: 'installed.physical-device-audio', scope: 'installed-candidate' },
];

export interface PrepHandback {
  schemaVersion: 1;
  kind: typeof PREP_HANDBACK_KIND;
  plan: string;
  fromItem: string;
  toItem: string;
  clause: { specId: string; revision: number; contentHash: string };
  source: {
    parentCommit: string;
    submodulePath: string;
    childCommit: string;
    change: { base: string; head: string };
    identities: Array<{ path: string; blob: string }>;
  };
  regressions: Array<{ testRunId: number; filePath: string }>;
  unresolvedChecks: Array<{ id: string; scope: string; status: string; owner: string; detail: string }>;
  claims: { acceptance: boolean; installed: boolean; currentMain: boolean };
  sequence: string[];
  sourcePosts: number[];
}

export interface LedgerRow {
  id: number;
  filePath: string;
  status: string;
  worktreeDirty: boolean | null;
  commitSha: string | null;
}

export interface ClauseRow {
  revision: number;
  contentHash: string;
  planItemId: string | null;
  requiredScenarios: string[];
}

export interface PrepHandbackDeps {
  /** Gitlink SHA the superproject `commit` records at `submodulePath`; null when absent. */
  gitlink(commit: string, submodulePath: string): Promise<string | null>;
  /** Blob SHA of `path` at `commit` inside the submodule; null when the path is absent. */
  blob(submodulePath: string, commit: string, path: string): Promise<string | null>;
  /** Exact `git diff --name-only base head` population inside the submodule. */
  changedFiles(submodulePath: string, base: string, head: string): Promise<string[]>;
  /** The submodule's registered suite command(s) at `commit` (package.json scripts). */
  registeredSuites(submodulePath: string, commit: string): Promise<string[]>;
  testRun(id: number): Promise<LedgerRow | null>;
  clause(plan: string, specId: string, revision: number): Promise<ClauseRow | null>;
}

export interface SubCheck { id: string; passed: boolean; evidence: string }
export interface CaseResult { id: string; passed: boolean; checks: SubCheck[] }

const SHA40 = /^[0-9a-f]{40}$/;

function push(checks: SubCheck[], id: string, passed: boolean, evidence: string): boolean {
  checks.push({ id, passed, evidence });
  return passed;
}

/** Structural validation shared by both cases; a malformed handback fails both. */
export function validateShape(value: unknown): { handback: PrepHandback | null; errors: string[] } {
  const errors: string[] = [];
  const h = value as Partial<PrepHandback> | null;
  if (!h || typeof h !== 'object') return { handback: null, errors: ['handback is not an object'] };
  if (h.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (h.kind !== PREP_HANDBACK_KIND) errors.push(`kind must be ${PREP_HANDBACK_KIND}`);
  for (const key of ['plan', 'fromItem', 'toItem'] as const) {
    if (typeof h[key] !== 'string' || !h[key]) errors.push(`${key} must be a non-empty string`);
  }
  const s = h.source;
  if (!s || typeof s !== 'object') errors.push('source is required');
  else {
    for (const key of ['parentCommit', 'childCommit'] as const) {
      if (!SHA40.test(String(s[key]))) errors.push(`source.${key} must be a 40-hex SHA`);
    }
    if (typeof s.submodulePath !== 'string' || !s.submodulePath) errors.push('source.submodulePath is required');
    if (!s.change || !SHA40.test(String(s.change.base)) || !SHA40.test(String(s.change.head))) {
      errors.push('source.change.base/head must be 40-hex SHAs');
    }
    if (!Array.isArray(s.identities) || s.identities.length === 0) errors.push('source.identities must be a non-empty array');
    else if (s.identities.some((i) => !i || typeof i.path !== 'string' || !SHA40.test(String(i.blob)))) {
      errors.push('every source identity needs a path and a 40-hex blob');
    }
  }
  if (!h.clause || typeof h.clause.specId !== 'string' || !Number.isInteger(h.clause.revision)
    || typeof h.clause.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(h.clause.contentHash)) {
    errors.push('clause must pin specId, integer revision and a 64-hex contentHash');
  }
  if (!Array.isArray(h.regressions)) errors.push('regressions must be an array');
  if (!Array.isArray(h.unresolvedChecks)) errors.push('unresolvedChecks must be an array');
  if (!h.claims || typeof h.claims !== 'object') errors.push('claims is required');
  if (!Array.isArray(h.sequence)) errors.push('sequence must be an array');
  return { handback: errors.length ? null : (h as PrepHandback), errors };
}

/** Case 1: the handed-off GNOME source identities are exactly right and were the tested bytes. */
export async function checkSourceIdentity(h: PrepHandback, deps: PrepHandbackDeps): Promise<CaseResult> {
  const checks: SubCheck[] = [];
  const { parentCommit, submodulePath, childCommit, change, identities } = h.source;

  const clause = await deps.clause(h.plan, h.clause.specId, h.clause.revision);
  push(checks, 'clause.pinned', !!clause && clause.contentHash === h.clause.contentHash && clause.planItemId === h.fromItem,
    clause ? `clause ${h.clause.specId}@${clause.revision} hash=${clause.contentHash.slice(0, 12)} item=${clause.planItemId}`
      : `clause ${h.clause.specId}@${h.clause.revision} not found`);
  push(checks, 'clause.requires-scenarios', !!clause
    && [SOURCE_IDENTITY_CASE, INSTALLED_BOUNDARY_CASE].every((id) => clause.requiredScenarios.includes(id)),
  `requiredScenarios=${JSON.stringify(clause?.requiredScenarios ?? [])}`);

  const pinned = await deps.gitlink(parentCommit, submodulePath);
  push(checks, 'gitlink.parent-pins-child', pinned === childCommit,
    `${parentCommit.slice(0, 12)}:${submodulePath} -> ${pinned ?? 'absent'} (handback ${childCommit.slice(0, 12)})`);
  push(checks, 'change.head-is-pinned-child', change.head === childCommit,
    `change.head=${change.head.slice(0, 12)} childCommit=${childCommit.slice(0, 12)}`);

  const paths = identities.map((i) => i.path);
  const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
  push(checks, 'identities.unique', duplicates.length === 0, duplicates.length ? `duplicate: ${duplicates.join(', ')}` : `${paths.length} distinct paths`);

  const changed = await deps.changedFiles(submodulePath, change.base, change.head);
  const missing = changed.filter((p) => !paths.includes(p));
  const extra = paths.filter((p) => !changed.includes(p));
  push(checks, 'identities.equal-changed-population', changed.length > 0 && missing.length === 0 && extra.length === 0,
    `changed(${change.base.slice(0, 12)}..${change.head.slice(0, 12)})=[${changed.join(', ')}] missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);

  for (const identity of identities) {
    const actual = await deps.blob(submodulePath, childCommit, identity.path);
    push(checks, `blob.${identity.path}`, actual === identity.blob,
      `${childCommit.slice(0, 12)}:${identity.path} = ${actual ?? 'absent'} (handback ${identity.blob.slice(0, 12)})`);
  }

  push(checks, 'regressions.present', h.regressions.length > 0, `${h.regressions.length} regression run ref(s)`);
  const suites = (await deps.registeredSuites(submodulePath, childCommit)).join('\n');
  for (const ref of h.regressions) {
    const row = await deps.testRun(ref.testRunId);
    const id = `regression.${ref.testRunId}`;
    if (!row) { push(checks, id, false, `test_runs ${ref.testRunId} not found`); continue; }
    const relative = row.filePath.startsWith(`${submodulePath}/`) ? row.filePath.slice(submodulePath.length + 1) : null;
    const registered = !!relative && suites.split(/\s+/).includes(relative);
    let testedBytesEqual = false;
    let tested = 'no commit';
    if (row.commitSha && SHA40.test(row.commitSha)) {
      const testedChild = await deps.gitlink(row.commitSha, submodulePath);
      tested = testedChild ? testedChild.slice(0, 12) : 'no gitlink';
      if (testedChild) {
        const blobs = await Promise.all(identities.map((i) => deps.blob(submodulePath, testedChild, i.path)));
        testedBytesEqual = blobs.every((b, i) => b === identities[i].blob);
      }
    }
    push(checks, id, row.status === 'pass' && row.worktreeDirty === false && row.filePath === ref.filePath && registered && testedBytesEqual,
      `${row.filePath} status=${row.status} dirty=${row.worktreeDirty} registered=${registered} testedChild=${tested} testedBytesEqualHandoff=${testedBytesEqual}`);
  }
  return { id: SOURCE_IDENTITY_CASE, passed: checks.every((c) => c.passed), checks };
}

/** Case 2: every required source/runtime and installed-candidate check is retained, unresolved. */
export function checkInstalledBoundary(h: PrepHandback): CaseResult {
  const checks: SubCheck[] = [];
  const ids = h.unresolvedChecks.map((c) => c.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  push(checks, 'unresolved.unique', duplicates.length === 0, duplicates.length ? `duplicate: ${duplicates.join(', ')}` : `${ids.length} distinct checks`);
  for (const required of REQUIRED_UNRESOLVED_CHECKS) {
    const entry = h.unresolvedChecks.find((c) => c.id === required.id);
    push(checks, `required.${required.id}`, !!entry && entry.scope === required.scope && entry.status === UNRESOLVED_STATUS
      && typeof entry.owner === 'string' && entry.owner.length > 0,
    entry ? `scope=${entry.scope} status=${entry.status} owner=${entry.owner}` : 'absent');
  }
  const resolved = h.unresolvedChecks.filter((c) => c.status !== UNRESOLVED_STATUS);
  push(checks, 'unresolved.none-marked-resolved', resolved.length === 0,
    resolved.length ? `not unresolved: ${resolved.map((c) => `${c.id}=${c.status}`).join(', ')}` : 'every listed check is unresolved');
  for (const scope of ['source-runtime', 'installed-candidate'] as const) {
    push(checks, `scope.${scope}`, h.unresolvedChecks.some((c) => c.scope === scope), `${h.unresolvedChecks.filter((c) => c.scope === scope).length} ${scope} check(s)`);
  }
  for (const key of ['acceptance', 'installed', 'currentMain'] as const) {
    push(checks, `claims.${key}`, h.claims[key] === false, `claims.${key}=${JSON.stringify(h.claims[key])}`);
  }
  push(checks, 'sequence.p001-p002-p003', JSON.stringify(h.sequence) === JSON.stringify(REQUIRED_SEQUENCE), `sequence=${JSON.stringify(h.sequence)}`);
  return { id: INSTALLED_BOUNDARY_CASE, passed: checks.every((c) => c.passed), checks };
}

/** Runs both cases. A malformed handback fails BOTH with the shape errors as evidence. */
export async function checkPrepHandback(value: unknown, deps: PrepHandbackDeps): Promise<CaseResult[]> {
  const { handback, errors } = validateShape(value);
  if (!handback) {
    const checks = [{ id: 'shape', passed: false, evidence: errors.join('; ') }];
    return [{ id: SOURCE_IDENTITY_CASE, passed: false, checks }, { id: INSTALLED_BOUNDARY_CASE, passed: false, checks }];
  }
  return [await checkSourceIdentity(handback, deps), checkInstalledBoundary(handback)];
}

/** Assertion evidence for the artifact: the per-check record stays complete in `checks`. */
export function summarizeCase(result: CaseResult): string {
  const failed = result.checks.filter((c) => !c.passed);
  const head = `${result.checks.length - failed.length}/${result.checks.length} checks passed`;
  const body = failed.length ? `; failed: ${failed.map((c) => `${c.id} (${c.evidence})`).join('; ')}` : '';
  const text = head + body;
  return text.length <= 2000 ? text : `${text.slice(0, 1940)} … [truncated; full list in artifact.checks]`;
}
