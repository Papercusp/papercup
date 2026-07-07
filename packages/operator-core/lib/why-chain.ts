/**
 * why-chain — "why is nothing shipping?" causal-chain explainer (EI-7349).
 *
 * During a deploy freeze the constituent facts already live in structured
 * data across several places: the green-checkpoint gate health + release-gate
 * snapshot (gitPipelineSnapshot), the recent test-run failures behind a red
 * streak (harness_shared.test_runs), and the account-pool rate-limit state
 * (accountStatus). Answering "why is nothing shipping" today means an agent
 * manually stitching those together (a real forensic exercise the 2026-07-03/
 * 04 13h freeze needed an SU session to assemble). This is the deterministic,
 * no-LLM 80% case: walk gate -> deploy -> pool top-down and render ONE causal
 * sentence per stage, naming the current blocking leaf.
 *
 * Pure composition — every data source is injectable so this is unit-testable
 * without a live DB / git checkout. Read-only: computes and returns, never
 * mutates any of the systems it reads.
 */
import { gitPipelineSnapshot, type GitPipelineSnapshot } from './git-pipeline-stats';
import { accountStatus, type AccountStatusRow } from './deployment/account-pool-store';

/** A postgres-js-like tagged-template client; injectable so this stays unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

const FAIL_STATUSES = new Set(['fail', 'error']);
// Same restored-checkout exclusion testing-flakiness.ts applies (a checkpoint/gate
// worktree copy uses a different path scheme than a harness's own root).
const RESTORED_CHECKOUT_PREFIX = 'papercupai-workspace/papercup-';

export type WhyChainStatus = 'ok' | 'degraded' | 'blocked';

export interface WhyChainStage {
  stage: 'gate' | 'deploy' | 'pool';
  status: WhyChainStatus;
  reason: string;
}

export interface WhyChainResult {
  generatedAtMs: number;
  stages: WhyChainStage[];
  /** The upstream-most non-ok stage — the leaf an owner should look at first. */
  rootCause: WhyChainStage | null;
  /** One causal sentence per stage, joined into the full chain. */
  summary: string;
  recentFailingFiles: string[];
}

export interface WhyChainDeps {
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  loadAccounts?: (ws?: string) => Promise<AccountStatusRow[]>;
  /** Test seam: inject a fake sql client for the recent-failures query. */
  sql?: SqlLike;
  workspaceId?: string;
  harnessSlug?: string;
}

/** Most recent distinct failing test files (fail/error), newest-first, capped at 5. */
export async function recentFailingFiles(deps: WhyChainDeps = {}): Promise<string[]> {
  let sql: SqlLike;
  try {
    if (deps.sql) {
      sql = deps.sql;
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
  } catch {
    return [];
  }
  // Plain-value interpolation (no nested `sql` fragment tags): a scoping filter
  // is expressed as `(<value> IS NULL OR col = <value>)` so every substitution
  // is an ordinary parameter, not a fragment the outer template must recognize
  // — this stays correct under a real postgres-js client AND a simplistic
  // test-mock sql function alike (a nested `sql`` fragment used as a plain
  // async call in a mock produces its own untracked promise).
  const harnessFilter = deps.harnessSlug ?? null;
  const workspaceFilter = deps.harnessSlug ? null : deps.workspaceId ?? null;
  try {
    const rows = (await sql`
      SELECT DISTINCT ON (file_path) file_path, status, finished_at
        FROM harness_shared.test_runs
       WHERE finished_at IS NOT NULL
         AND finished_at > now() - interval '2 hours'
         AND status IN ('fail', 'error')
         AND file_path NOT LIKE ${RESTORED_CHECKOUT_PREFIX + '%'}
         AND (${harnessFilter}::text IS NULL OR harness_slug = ${harnessFilter})
         AND (${workspaceFilter}::text IS NULL OR workspace_id = ${workspaceFilter})
       ORDER BY file_path ASC, finished_at DESC
    `) as unknown as Array<{ file_path: string; finished_at: string }>;
    return rows
      .sort((a, b) => new Date(b.finished_at).getTime() - new Date(a.finished_at).getTime())
      .slice(0, 5)
      .map((r) => r.file_path);
  } catch {
    // best-effort: a missing table / query failure degrades to "unknown", not a throw.
    return [];
  }
}

function gateStage(snap: GitPipelineSnapshot, failingFiles: string[]): WhyChainStage {
  const g = snap.gate;
  const filesNote = failingFiles.length ? ` — recent failing file(s): ${failingFiles.join(', ')}` : '';
  if (snap.openConflict) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `an OPEN merge conflict is unresolved (scopes: ${snap.openConflict.scopes.join(', ') || 'unknown'}) — git-sync cannot advance staging until it resolves`,
    };
  }
  if (g.fireStale) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate is WEDGED — not firing (${g.fireStaleReason ?? 'stale'})`,
    };
  }
  if (g.stalled) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate STALLED after ${g.consecutiveReds} consecutive reds${filesNote}`,
    };
  }
  if (g.consecutiveReds > 0) {
    return {
      stage: 'gate',
      status: 'degraded',
      reason: `gate red (${g.consecutiveReds} consecutive, not yet stalled)${filesNote}`,
    };
  }
  return { stage: 'gate', status: 'ok', reason: 'green-checkpoint gate is green' };
}

function deployStage(snap: GitPipelineSnapshot): WhyChainStage {
  const d = snap.deploy;
  if (d.readyBehindMain != null && d.readyBehindMain > 0) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `main is ${d.readyBehindMain} commit(s) ahead of the green pin (\`ready\`) — the tip hasn't been promoted (downstream of the gate above)`,
    };
  }
  if (d.deployedBehindReady != null && d.deployedBehindReady > 0) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `\`ready\` is green and ${d.deployedBehindReady} commit(s) ahead of what's live on :3070 — deployed but not yet promoted/restarted`,
    };
  }
  if (d.errors.length) {
    return { stage: 'deploy', status: 'degraded', reason: `deploy snapshot incomplete: ${d.errors.join('; ')}` };
  }
  return { stage: 'deploy', status: 'ok', reason: 'deployed :3070 matches the green pin matches main HEAD — fully caught up' };
}

function poolStage(accounts: AccountStatusRow[]): WhyChainStage {
  if (accounts.length === 0) {
    return { stage: 'pool', status: 'degraded', reason: 'no accounts registered in the pool (unable to assess)' };
  }
  const available = accounts.filter((a) => a.available);
  const sustained = accounts.filter((a) => a.sustainedlyLimited);
  if (available.length === 0) {
    // WI-3310: name the usage wall distinctly — "rate-limited/paused" clears in minutes, a
    // usage-walled account cannot serve until its (possibly days-away) window reset.
    const walled = accounts.filter((a) => a.usageWalled).length;
    return {
      stage: 'pool',
      status: 'blocked',
      reason: `all ${accounts.length} account(s) in the pool are currently unavailable (${walled} usage-walled until their window resets, ${accounts.length - walled} rate-limited/paused) — no spawn capacity`,
    };
  }
  if (sustained.length > 0) {
    return {
      stage: 'pool',
      status: 'degraded',
      reason: `${sustained.length}/${accounts.length} account(s) sustained-limited (${available.length} still available)`,
    };
  }
  return { stage: 'pool', status: 'ok', reason: `${available.length}/${accounts.length} accounts available, none sustained-limited` };
}

/** Compute the full why-chain (gate -> deploy -> pool), pure + read-only. */
export async function computeWhyChain(deps: WhyChainDeps = {}): Promise<WhyChainResult> {
  const loadSnapshot = deps.loadSnapshot ?? (() => gitPipelineSnapshot());
  const loadAccounts = deps.loadAccounts ?? ((ws?: string) => accountStatus(ws));

  const [snap, accounts, failingFiles] = await Promise.all([
    loadSnapshot(),
    loadAccounts(deps.workspaceId).catch(() => [] as AccountStatusRow[]),
    recentFailingFiles(deps),
  ]);

  const stages: WhyChainStage[] = [gateStage(snap, failingFiles), deployStage(snap), poolStage(accounts)];
  const rootCause = stages.find((s) => s.status !== 'ok') ?? null;

  const chainLine = stages.map((s) => `${s.stage.toUpperCase()}: ${s.status} (${s.reason})`).join(' → ');
  const summary = rootCause
    ? `${chainLine}\n\nROOT CAUSE: ${rootCause.stage} — ${rootCause.reason}`
    : `${chainLine}\n\nAll stages nominal — nothing in the gate/deploy/pool chain appears to be blocking shipping right now.`;

  return {
    generatedAtMs: Date.now(),
    stages,
    rootCause,
    summary,
    recentFailingFiles: failingFiles,
  };
}
