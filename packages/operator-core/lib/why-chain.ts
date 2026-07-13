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
import { runtimeDiagnostic, type RuntimeDiagnostic } from './runtime-diagnostic';

/** A postgres-js-like tagged-template client; injectable so this stays unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

const FAIL_STATUSES = new Set(['fail', 'error']);
// Same restored-checkout exclusion testing-flakiness.ts applies (a checkpoint/gate
// worktree copy uses a different path scheme than a harness's own root).
const RESTORED_CHECKOUT_PREFIX = 'papercupai-workspace/papercup-';

export type WhyChainStatus = 'ok' | 'degraded' | 'blocked';

/** Live gateway ADMISSION snapshot (the subset of :8788/admin/stats the chain judges). EI-10880. */
export interface AdmissionSnapshotLite {
  running: number;
  queued: number;
  maxConcurrent: number;
  tier1Reserve?: number;
  byTier?: { tier: number; cap: number | null; inFlight: number; queued: number }[];
  /** AIMD effective vs configured cap — a deep shrink is worth naming even when nothing is queued. */
  aimdEffective?: number;
  aimdCap?: number;
}

export interface WhyChainStage {
  stage: 'gate' | 'deploy' | 'admission' | 'pool';
  status: WhyChainStatus;
  reason: string;
  /**
   * WI-4577 — the DECISIVE next tool call for this stage, present ONLY when `status !== 'ok'`
   * (an ok stage needs no action). This is not new advice: it is the exact drill-down mapping
   * `dev:why`'s own `guidance.chaining` already spells out in prose (gate → testing:flakiness,
   * deploy → release:deploy/dev:pipeline_position, admission → gateway:status, pool →
   * accounts:status) — surfaced here as DATA on the stage that names it, so a caller parsing the
   * JSON response gets the decisive tool without a second read of this tool's own guidance text
   * (the same "derived claim without its caveat/action" gap EI-10951 named: advice that only
   * lives in prose an agent must separately notice is advice a machine-following agent can miss).
   */
  nextVerb?: string;
}

export interface WhyChainResult extends RuntimeDiagnostic<
  { stageOrder: WhyChainStage['stage'][]; workspaceId: string | null; harnessSlug: string | null },
  { status: WhyChainStatus; blockingStage: WhyChainStage['stage'] | null },
  { stages: WhyChainStage[]; recentFailingFiles: string[] },
  WhyChainStage
> {
  generatedAtMs: number;
  stages: WhyChainStage[];
  /** The upstream-most non-ok stage — the leaf an owner should look at first. */
  rootCause: WhyChainStage | null;
  /** One causal sentence per stage, joined into the full chain. */
  summary: string;
  recentFailingFiles: string[];
}

/**
 * WI-4577: ONE source of truth for "the decisive next tool" — each stage function above already
 * names its own `nextVerb` at the exact branch that knows WHY it is non-ok (e.g. a stale verdict
 * needs a fresh checkpoint run, not the tests it names; a wedged routine needs the same). Reading
 * it back off `rootCause` here (rather than re-deriving it from `reason` text) means the top-level
 * `WhyChainResult.nextVerb` and `rootCause.nextVerb` can never disagree — they are the same field.
 */
function nextVerbForRoot(rootCause: WhyChainStage | null): string | null {
  return rootCause?.nextVerb ?? null;
}

export interface WhyChainDeps {
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  loadAccounts?: (ws?: string) => Promise<AccountStatusRow[]>;
  /** Test seam / override for the live gateway ADMISSION read (EI-10880). Null ⇒ gateway unreachable. */
  loadAdmission?: () => Promise<AdmissionSnapshotLite | null>;
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

/**
 * The gate's COLOUR as a single label — the one word an agent acts on. Derived here, next to
 * gateStage, so every consumer (dev:why's chain AND coord:orient's wake fold, WI-4533) reads the
 * SAME rule: two surfaces that disagree about whether the gate is red is worse than either being
 * silent.
 *
 * `stale-verdict` is deliberately its OWN colour, not a red — see gateStage below.
 */
export type GateLabel = 'green' | 'red' | 'stalled' | 'wedged' | 'stale-verdict' | 'conflict';

export function gateLabel(snap: GitPipelineSnapshot): GateLabel {
  const g = snap.gate;
  if (snap.openConflict) return 'conflict';
  if (g.fireStale) return 'wedged';
  if (g.verdictStale && g.consecutiveReds > 0) return 'stale-verdict';
  if (g.stalled) return 'stalled';
  if (g.consecutiveReds > 0) return 'red';
  return 'green';
}

/**
 * WHAT IS ACTUALLY RED — the gate's own verdict first, the time-window proxy second (WI-4533).
 *
 * `gate_health.failingTests` is the checkpoint naming the tests that redded IT. `recentFailingFiles`
 * is a 2h scan of `test_runs` — a proxy that answers a *different* question ("what failed lately,
 * anywhere") and can easily be empty for a genuinely red gate. Measured live on a red gate
 * (2026-07-13): the proxy returned NOTHING while the gate's own record held all four culprits, so
 * the chain reported "gate red" and named nobody. Prefer first-hand evidence; keep the proxy as the
 * fallback for an older blob that never recorded any.
 */
export function namedFailures(snap: GitPipelineSnapshot, recentFiles: string[]): string[] {
  return snap.gate.failingTests?.length ? snap.gate.failingTests : recentFiles;
}

function gateStage(snap: GitPipelineSnapshot, failingFiles: string[]): WhyChainStage {
  const g = snap.gate;
  const named = namedFailures(snap, failingFiles);
  const filesNote = named.length ? ` — failing: ${named.slice(0, 6).join(', ')}` : '';
  if (snap.openConflict) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `an OPEN merge conflict is unresolved (scopes: ${snap.openConflict.scopes.join(', ') || 'unknown'}) — git-sync cannot advance staging until it resolves`,
      // Resolution is a coordination hand-off (merge-resolver), not a single diagnostic call —
      // no nextVerb: naming one here would misrepresent a routing decision as a tool call.
    };
  }
  if (g.fireStale) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate is WEDGED — not firing (${g.fireStaleReason ?? 'stale'})`,
      // A non-firing routine needs a fresh run, not a position read (matches nextVerbForRoot).
      nextVerb: 'release:checkpoint-run',
    };
  }
  // WI-4533: a STALE red is not a red — it is an UNKNOWN, and it must never be rendered as the
  // gate's colour. The snapshot has carried `verdictStale` since WI-4489 ("a stale red must never
  // be reported as the gate's colour, nor dispatch anyone at the tests it names") but this chain —
  // the very read an agent uses to decide what to go fix — never consulted it, so it kept
  // reporting a confident RED off a verdict the system already knew was superseded. That is the
  // exact 3.5h phantom WI-4489 documented: a starved `gate_health` blob reporting 4 reds while
  // every real run was green, which dispatched the release-fixer at 8 tests that all passed — and
  // whose manual runs then held the lock that kept the blob stale. Naming the files here would
  // re-arm precisely that loop, so the stale branch names NONE of them.
  //
  // Ordered ABOVE `stalled`/`consecutiveReds` on purpose: both of those read the same untrusted
  // streak. Freshness is only ever judged for a RED (a stale GREEN misdirects nobody — see
  // gate-verdict-freshness.ts), so a green verdict can never land here.
  if (g.verdictStale && g.consecutiveReds > 0) {
    return {
      stage: 'gate',
      status: 'degraded',
      reason:
        `gate verdict is STALE (${g.verdictStaleReason ?? 'superseded/unverified'}) — the recorded ` +
        `${g.consecutiveReds} red(s) are NOT current, so the gate's colour is UNKNOWN. Do not dispatch ` +
        `anyone at the test(s) it names; re-run the checkpoint to get a real verdict (WI-4489).`,
      // The decisive action for a STALE verdict is a fresh verdict, never the named tests.
      nextVerb: 'release:checkpoint-run',
    };
  }
  if (g.stalled) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate STALLED after ${g.consecutiveReds} consecutive reds${filesNote}`,
      nextVerb: 'testing:flakiness',
    };
  }
  if (g.consecutiveReds > 0) {
    return {
      stage: 'gate',
      status: 'degraded',
      reason: `gate red (${g.consecutiveReds} consecutive, not yet stalled)${filesNote}`,
      nextVerb: 'testing:flakiness',
    };
  }
  return { stage: 'gate', status: 'ok', reason: 'green-checkpoint gate is green' };
}

/**
 * The DEPLOY stage asks exactly one question: is code that ALREADY PASSED the gate sitting
 * un-shipped? That is `deployedBehindGreenPin` — the green pin (`main`) is ahead of what runs
 * on :3070.
 *
 * ⚠ EI-11012 — it deliberately does NOT fire on `greenPinBehindStaging` (the STAGING BUFFER:
 * staging ahead of the green pin). This stage used to, believing that field meant "the tip
 * hasn't been promoted". It doesn't — it is the normal steady state of this fleet: git-sync
 * commits `staging` continuously while the green-checkpoint FFs `main` only hourly and only
 * when green, so the buffer is essentially ALWAYS > 0. Firing on it made the deploy stage
 * report `degraded` permanently, which is worse than noise on TWO counts:
 *   1. computeWhyChain() reports the FIRST non-ok stage as the rootCause, so a permanently
 *      degraded deploy stage SHADOWED every real downstream cause (admission, pool, ...);
 *   2. it told agents their code wasn't live when it was — inviting a pointless force-deploy
 *      (a real :3070 restart) or a phantom chase.
 * A buffer that stays large for a long time IS worth knowing about, but that is a GATE/promotion
 * question ("is the gate still advancing main?"), time-thresholded — not a `> 0` boolean here.
 * The gate stage above already owns it (consecutiveReds / stall detection).
 */
function deployStage(snap: GitPipelineSnapshot): WhyChainStage {
  const d = snap.deploy;
  if (d.deployedBehindGreenPin != null && d.deployedBehindGreenPin > 0) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `the green pin (\`main\`) is green and ${d.deployedBehindGreenPin} commit(s) ahead of what's live on :3070 — gated but not yet deployed/restarted`,
      nextVerb: 'release:deploy',
    };
  }
  if (d.errors.length) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `deploy snapshot incomplete: ${d.errors.join('; ')}`,
      nextVerb: 'dev:pipeline_position',
    };
  }
  const buffer =
    d.greenPinBehindStaging != null && d.greenPinBehindStaging > 0
      ? ` (${d.greenPinBehindStaging} commit(s) of staging buffer await the next gate run — normal)`
      : '';
  return {
    stage: 'deploy',
    status: 'ok',
    reason: `deployed :3070 matches the green pin (\`main\`) — everything that passed the gate is live${buffer}`,
  };
}

/**
 * ADMISSION stage (EI-10880) — the layer between "the pool has capacity" and "a request runs".
 *
 * WHY THIS STAGE EXISTS. WI-4541: the gateway serialized the ENTIRE fleet through ONE admission
 * slot (untagged traffic → the bottom tier, whose cap the AIMD shed had driven to its floor of 1)
 * while 9-10 of 12 concurrency slots sat IDLE. Every agent was slow; the owner's voice turns hung
 * ("processing forever"). Walking gate → deploy → pool would have found all three OK and named NO
 * root cause — and worse, the pool stage would have reported "accounts available, none
 * sustained-limited", which actively supports the WRONG conclusion ("must just be load"). The
 * causal chain has to be able to see the queue itself, not just the capacity feeding it.
 *
 * THE DECISIVE TEST — queued while idle. If anything is QUEUED while the pool still has free
 * shared slots (running < maxConcurrent - tier1Reserve), that is DEFINITIONALLY a bug: work is
 * waiting on capacity that exists. No account is walled, no rate limit is involved, and adding
 * pool headroom cannot fix it. It is an admission-path defect, and it is cheap to check.
 *
 * Ordered BEFORE `pool` deliberately: when both are unhappy, the admission defect is the root
 * cause and the pool pressure is downstream of it (requests pile up because they can't get in).
 * A genuinely walled pool with a healthy queue still falls through to poolStage below.
 */
function admissionStage(adm: AdmissionSnapshotLite | null): WhyChainStage {
  if (!adm) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason: 'inference gateway unreachable on :8788 (admission state unknown — is papercup-inference-gateway.service running?)',
      nextVerb: 'gateway:status',
    };
  }
  const reserve = adm.tier1Reserve ?? 0;
  // Free SHARED capacity — what a tier > 1 is actually allowed to occupy. The tier-1 reserve is
  // held open on purpose, so it is NOT "idle capacity" for this test; excluding it keeps the
  // check honest (no false alarm just because the interactive floor is being held).
  const freeShared = Math.max(0, adm.maxConcurrent - reserve - adm.running);

  if (adm.queued > 0 && freeShared > 0) {
    const perTier = (adm.byTier ?? [])
      .filter((t) => t.queued > 0)
      .map((t) => `tier ${t.tier} (cap ${t.cap ?? '∞'}, ${t.inFlight} in flight, ${t.queued} queued)`)
      .join(', ');
    return {
      stage: 'admission',
      status: 'blocked',
      reason:
        `${adm.queued} request(s) QUEUED at the gateway while ${freeShared} shared slot(s) sit IDLE ` +
        `(running ${adm.running}/${adm.maxConcurrent}, tier-1 reserve ${reserve})` +
        (perTier ? ` — waiting: ${perTier}` : '') +
        `. This is an ADMISSION-PATH DEFECT, not a capacity shortage: the work is waiting on capacity that already exists, ` +
        `so more pool headroom will NOT fix it. Suspect a per-tier cap refusing an idle slot, or a tier whose cap the AIMD shed drove to its floor (WI-4541). ` +
        `Read gateway:status for the per-tier detail.`,
      nextVerb: 'gateway:status',
    };
  }
  // A deep AIMD shrink is not itself a bug (it is the gateway protecting upstream from sustained
  // 429s) but it IS the thing that makes a low tier cap collapse, so name it before it bites.
  if (adm.aimdCap != null && adm.aimdEffective != null && adm.aimdEffective < adm.aimdCap / 2) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason: `gateway AIMD has shrunk effective concurrency to ${adm.aimdEffective}/${adm.aimdCap} under sustained upstream pressure — throughput is throttled on purpose, but a shed this deep also squeezes the bottom tiers' caps toward their floor of 1 (the WI-4541 precondition); watch for queued-while-idle`,
      nextVerb: 'gateway:status',
    };
  }
  if (adm.queued > 0) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason: `${adm.queued} request(s) queued, but the pool is genuinely FULL (running ${adm.running}/${adm.maxConcurrent}) — admission is behaving correctly; this is real saturation, look at the pool stage`,
      // Admission is behaving correctly here — the decisive next read is the pool it's saturated on.
      nextVerb: 'accounts:status',
    };
  }
  return { stage: 'admission', status: 'ok', reason: `gateway admission healthy — ${adm.running}/${adm.maxConcurrent} in flight, nothing queued` };
}

function poolStage(accounts: AccountStatusRow[]): WhyChainStage {
  if (accounts.length === 0) {
    return {
      stage: 'pool',
      status: 'degraded',
      reason: 'no accounts registered in the pool (unable to assess)',
      nextVerb: 'accounts:status',
    };
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
      nextVerb: 'accounts:status',
    };
  }
  if (sustained.length > 0) {
    return {
      stage: 'pool',
      status: 'degraded',
      reason: `${sustained.length}/${accounts.length} account(s) sustained-limited (${available.length} still available)`,
      nextVerb: 'accounts:status',
    };
  }
  return { stage: 'pool', status: 'ok', reason: `${available.length}/${accounts.length} accounts available, none sustained-limited` };
}

/** Read the live gateway admission snapshot (:8788/admin/stats). Fail-soft: null when unreachable. */
async function loadAdmissionDefault(): Promise<AdmissionSnapshotLite | null> {
  const port = Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      admission?: { running?: number; queued?: number; maxConcurrent?: number; tier1Reserve?: number; byTier?: AdmissionSnapshotLite['byTier'] };
      aimd?: { effective?: number; cap?: number };
    };
    const a = d.admission;
    if (!a || typeof a.running !== 'number' || typeof a.maxConcurrent !== 'number') return null;
    return {
      running: a.running,
      queued: a.queued ?? 0,
      maxConcurrent: a.maxConcurrent,
      tier1Reserve: a.tier1Reserve,
      byTier: a.byTier,
      aimdEffective: d.aimd?.effective,
      aimdCap: d.aimd?.cap,
    };
  } catch {
    return null; // gateway down / not running — admissionStage reports it as degraded, never throws
  }
}

/**
 * PIPELINE HEALTH — the gate + deploy legs only (WI-4533 / P-006).
 *
 * WHY A SECOND ENTRY POINT rather than just calling computeWhyChain: this one is folded into
 * `coord:orient`, the hottest read in the fleet (2256 calls / 425 agents / 7d), so it must be
 * CHEAP and it must be SILENT when it has nothing to say:
 *
 *   - it skips the ADMISSION leg (an HTTP fetch to the gateway) and the POOL leg (accountStatus)
 *     — those answer "why is everything slow", which is not what a waking agent needs to know
 *     before touching code. Gate + deploy answer "will my change ship, and is the tree healthy",
 *     which is;
 *   - it fetches the recent failing FILES only when the gate is not green — no red, no query;
 *   - it reports `known: false` (rather than a cheerful green) for a harness that has no
 *     green-checkpoint routine at all. A detector with no data must say UNKNOWN, never OK — the
 *     same rule the stale-verdict branch above enforces. A false green at wake is worse than
 *     silence: it is an agent shipping into a pipeline it believes is healthy.
 *
 * It shares gateStage/deployStage/gateLabel VERBATIM with dev:why, so the wake fold and the
 * causal chain can never drift into disagreeing about the gate's colour.
 */
export interface PipelineHealth {
  generatedAtMs: number;
  /** false ⇒ this harness has no green-checkpoint routine: nothing is known, report NOTHING. */
  known: boolean;
  gate: WhyChainStage;
  deploy: WhyChainStage;
  gateLabel: GateLabel;
  consecutiveReds: number;
  lastGreenAtMs: number | null;
  /** WI-4489: the recorded red is superseded/unverified — its colour is UNKNOWN, not red. */
  verdictStale: boolean;
  /** Commits on `main` not yet promoted to the green pin (`ready`). */
  greenPinBehindStaging: number | null;
  /** Commits on the green pin not yet live on :3070. */
  deployedBehindGreenPin: number | null;
  recentFailingFiles: string[];
  /** The upstream-most non-ok leg of THIS chain (gate, then deploy) — null when both are ok. */
  rootCause: WhyChainStage | null;
}

export async function computePipelineHealth(
  deps: WhyChainDeps & { slug?: string } = {},
): Promise<PipelineHealth> {
  const loadSnapshot = deps.loadSnapshot ?? (() => gitPipelineSnapshot(deps.slug));
  const snap = await loadSnapshot();
  const now = Date.now();

  // No green-checkpoint routine for this harness ⇒ there IS no gate to report on. Say so; a
  // zero-red `gate_health` on a harness that never runs a checkpoint would otherwise render as a
  // confident "green" (the snapshot defaults consecutiveReds to 0).
  if (!snap.routines.greenCheckpoint) {
    const unknown: WhyChainStage = { stage: 'gate', status: 'degraded', reason: 'no green-checkpoint routine for this harness — gate state unknown' };
    return {
      generatedAtMs: now,
      known: false,
      gate: unknown,
      deploy: deployStage(snap),
      gateLabel: 'green',
      consecutiveReds: 0,
      lastGreenAtMs: null,
      verdictStale: false,
      greenPinBehindStaging: null,
      deployedBehindGreenPin: null,
      recentFailingFiles: [],
      rootCause: null,
    };
  }

  // The failing-files query is the only extra IO, and it is skipped TWICE over: a GREEN gate never
  // pays for it, and neither does a red gate that already NAMED its own failures (the common case
  // — see namedFailures). The proxy scan is the last resort, not the first read.
  const provisional = gateStage(snap, []);
  // `?? []` (not `?.length === 0`): a blob written before failingTests existed has the field
  // UNDEFINED, and `undefined === 0` is false — which would have silently skipped the fallback
  // scan for exactly the old gates that most need it.
  const needsProxy = provisional.status !== 'ok' && (snap.gate.failingTests ?? []).length === 0;
  const proxyFiles = needsProxy ? await recentFailingFiles(deps) : [];
  const gate = proxyFiles.length ? gateStage(snap, proxyFiles) : provisional;
  const deploy = deployStage(snap);
  const failingFiles = namedFailures(snap, proxyFiles);

  return {
    generatedAtMs: now,
    known: true,
    gate,
    deploy,
    gateLabel: gateLabel(snap),
    consecutiveReds: snap.gate.consecutiveReds,
    lastGreenAtMs: snap.gate.lastGreenAtMs,
    verdictStale: snap.gate.verdictStale,
    greenPinBehindStaging: snap.deploy.greenPinBehindStaging ?? null,
    deployedBehindGreenPin: snap.deploy.deployedBehindGreenPin ?? null,
    recentFailingFiles: failingFiles,
    rootCause: [gate, deploy].find((s) => s.status !== 'ok') ?? null,
  };
}

/** Compute the full why-chain (gate -> deploy -> admission -> pool), pure + read-only. */
export async function computeWhyChain(deps: WhyChainDeps = {}): Promise<WhyChainResult> {
  const loadSnapshot = deps.loadSnapshot ?? (() => gitPipelineSnapshot());
  const loadAccounts = deps.loadAccounts ?? ((ws?: string) => accountStatus(ws));
  const loadAdmission = deps.loadAdmission ?? loadAdmissionDefault;

  const [snap, accounts, admission, failingFiles] = await Promise.all([
    loadSnapshot(),
    loadAccounts(deps.workspaceId).catch(() => [] as AccountStatusRow[]),
    loadAdmission().catch(() => null),
    recentFailingFiles(deps),
  ]);

  const stages: WhyChainStage[] = [
    gateStage(snap, failingFiles),
    deployStage(snap),
    admissionStage(admission),
    poolStage(accounts),
  ];
  const rootCause = stages.find((s) => s.status !== 'ok') ?? null;

  const chainLine = stages.map((s) => `${s.stage.toUpperCase()}: ${s.status} (${s.reason})`).join(' → ');
  const summary = rootCause
    ? `${chainLine}\n\nROOT CAUSE: ${rootCause.stage} — ${rootCause.reason}`
    : `${chainLine}\n\nAll stages nominal — nothing in the gate/deploy/pool chain appears to be blocking shipping right now.`;

  const diagnostic = runtimeDiagnostic({
    configured: {
      stageOrder: stages.map((s) => s.stage),
      workspaceId: deps.workspaceId ?? null,
      harnessSlug: deps.harnessSlug ?? null,
    },
    effective: {
      status: rootCause?.status ?? 'ok',
      blockingStage: rootCause?.stage ?? null,
    },
    evidence: { stages, recentFailingFiles: failingFiles },
    rootCause,
    nextVerb: nextVerbForRoot(rootCause),
  });

  return {
    generatedAtMs: Date.now(),
    stages,
    summary,
    recentFailingFiles: failingFiles,
    ...diagnostic,
  };
}
