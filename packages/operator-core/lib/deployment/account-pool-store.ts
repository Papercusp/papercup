/**
 * Account-pool IO + wiring (`cloud-deployment-layer-2026-06-06` Phase 7).
 *
 * The pure decisions live in `account-pool.ts`; this file is the operator-side
 * host that connects them to the real world:
 *   - **persistence** — the pool is single-row-per-workspace JSONB in
 *     `harness_shared.operator_account_pool` (migration 190), the operator-state idiom.
 *   - **P-020 deploy-time selection** — `selectAccountForDeploy` binds the
 *     most-available account to a member's `DeploymentConfig.credentialRef/accountId`.
 *   - **P-019/P-021 rate bridge** — `initAccountScaleObserver` subscribes the
 *     existing governor `onGovernorPause` signal, records each account's pause into
 *     the pool projection, and (when sustained) emits a `rate-limit:exhausted:<id>`
 *     event + drives the scale-out reaction.
 *   - **P-021 scale-out** — `handleAccountExhausted` provisions a fresh Swarm (a new
 *     cloud frame on a fresh account) for the exhausted account's bound members,
 *     instead of only pausing. Deps are injected so the whole reaction is
 *     unit-testable with a mock driver (real provisioning is owner-gated).
 */
import type { DeploymentConfig, Frame, LogLevel } from '@papercusp/deployment-driver';
import { onGovernorPause, parseGovernorKey, snapshotGovernors } from '@papercusp/papercusp-shared/agent';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { readOpusBudgetPolicy } from '../opus-budget-policy';
import { readScalePolicy } from '../scale-policy';
import {
  type AccountEgress,
  type AccountPool,
  type AccountRateState,
  type ScalePolicy,
  type SpawnSelection,
  accountFull,
  bindAccount,
  clearSoftPin,
  decideScaleOut,
  getAccount,
  isAvailable,
  isClassExhausted,
  isSustainedlyLimited,
  manuallyBoundAccount,
  recordAccountPenalty,
  selectAccountByHeadroom,
  selectAccountForSpawn,
  setSoftPin,
  softPinnedAccount,
  unbindAccount,
} from './account-pool';
import {
  getAccountOverride,
  applyAccountOverride,
  isOverrideEmpty,
  DEFAULT_ACCOUNT_OVERRIDE,
  type AccountSessionOverride,
} from './account-session-override';
import {
  evaluateOpusBudget,
  type OpusBudgetDecision,
  type WorkCriticality,
} from '../opus-budget-governor';

// ── P-004: the owner's session-now account override (fail-soft, no-op-when-unset) ──

/**
 * Read the owner's session-now account override (P-004) — FAIL-SOFT: any error returns the
 * empty (no-restriction) override, so the live spawn/deploy selectors can never wedge on a
 * bad read. Workspace-level (D-015): the override lives on a per-workspace pseudo-slug in
 * hive_settings and applies regardless of the spawning harness (no home hive required).
 */
async function readAccountOverride(ws: string | undefined): Promise<AccountSessionOverride> {
  try {
    return await getAccountOverride(ws ?? activeWorkspaceId());
  } catch {
    return DEFAULT_ACCOUNT_OVERRIDE;
  }
}

// ── Persistence (operator-state idiom) ───────────────────────────────────────

export async function loadAccountPool(ws?: string): Promise<AccountPool> {
  const raw = await readOperatorState<AccountPool>('operator_account_pool', ws);
  return { accounts: raw?.accounts ?? [] };
}

export async function saveAccountPool(pool: AccountPool, ws?: string): Promise<void> {
  await writeOperatorState('operator_account_pool', { accounts: pool.accounts }, ws);
}

/**
 * Persist a NEWLY-assigned soft cache-affinity pin (account-cache-affinity-auto-pin Phase 1) under an
 * ATOMIC read-modify-write so N bees spawning concurrently for a fresh harness all converge on the SAME
 * account (P-005 concurrency). The write is a CAS-by-reconcile: if a CONCURRENT spawn already soft-pinned
 * this harness to a still-budgeted account, that winning pin stands (we return its id) and we DON'T
 * clobber it; otherwise we set the pin to `accountId`. A manual `boundTo` bind always wins (D-001) — when
 * present we clear any stray soft pin and route to the bind. Fail-soft: a write error returns the
 * originally-selected `accountId` (the spawn still routes; only the persisted affinity is lost).
 */
async function persistSoftPin(
  ws: string | undefined,
  harness: string,
  accountId: string,
  now: number,
): Promise<string> {
  try {
    let winner = accountId;
    await updateAccountPool((p) => {
      // Owner bind wins — never auto-pin over it (D-001). Clear any stale soft pin and defer to the bind.
      const bound = manuallyBoundAccount(p, harness);
      if (bound) {
        winner = bound.id;
        return clearSoftPin(p, harness);
      }
      // A concurrent spawn already pinned this harness to a still-budgeted account → keep that pin (CAS).
      const existing = softPinnedAccount(p, harness);
      if (existing && !accountFull(existing, now)) {
        winner = existing.id;
        return p;
      }
      winner = accountId;
      return setSoftPin(p, accountId, harness);
    }, ws);
    return winner;
  } catch {
    return accountId; // affinity write lost — the spawn still routes to the selected account
  }
}

/**
 * Resolve the pool account a spawning (or in-process) call should egress through (P-004/P-005). Loads
 * the pool (fail-soft → undefined on any IO error), applies the cache-affinity selection, and PERSISTS
 * a fresh soft auto-pin so the harness's consecutive bees co-locate on one credential's prompt cache
 * (account-cache-affinity-auto-pin Phase 1). Returns undefined when there are ≤1 accounts (no routing
 * needed — the gateway's active() account serves) or nothing is available, so the caller sets no header.
 */
export async function selectSpawnAccount(
  ws: string | undefined,
  harness: string | undefined,
  priorAccountId?: string,
): Promise<string | undefined> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool) return undefined;
  const now = Date.now();
  // P-004: apply the owner's session-now override BEFORE selection (fail-soft, no-op when
  // unset). A `forced` allow-list restricts the candidates; `exclude` skips some. An
  // over-restrictive override (no candidate survives) → undefined = the frame-default
  // credential, exactly as an empty pool behaves today.
  const override = await readAccountOverride(ws);
  if (!isOverrideEmpty(override)) {
    const allowed = applyAccountOverride(
      pool.accounts.map((a) => a.id),
      override,
    );
    if (allowed.length === 0) return undefined;
    // A single surviving account IS the pick (forced-to-one, or the sole non-excluded) —
    // pin it (the owner's explicit choice; pause/failover is handled downstream).
    if (allowed.length === 1) return allowed[0];
    const allow = new Set(allowed);
    const sel = selectAccountForSpawn({ accounts: pool.accounts.filter((a) => allow.has(a.id)) }, now, {
      harness,
      priorAccountId,
    });
    return resolveSelection(ws, sel, now);
  }
  // No override → today's exact path: no routing needed for ≤1 account.
  if (pool.accounts.length <= 1) return undefined;
  const sel = selectAccountForSpawn(pool, now, { harness, priorAccountId });
  return resolveSelection(ws, sel, now);
}

/** Apply a `SpawnSelection`: persist a newly-assigned soft pin (atomic CAS) and return the routed id. */
async function resolveSelection(ws: string | undefined, sel: SpawnSelection, now: number): Promise<string | undefined> {
  if (sel.newlyPinned) return persistSoftPin(ws, sel.newlyPinned.harness, sel.newlyPinned.accountId, now);
  return sel.accountId;
}

/**
 * Account-AWARE replacement for the old account-BLIND "is the opus class paused?" check
 * (account-aware-rate-governor-routing-2026-06-16 Phase 1). The global `<provider>:<modelClass>`
 * governor bucket is account-blind: ONE account's 429 pauses it for the whole fleet even with idle
 * accounts (the owner's "rate-limit-with-headroom = routing bug"). This consults the POOL instead —
 * the class is genuinely paused ONLY when EVERY account is full (paused or at/over its 5h cap). With
 * ≥1 account having headroom this is false, so the caller keeps admitting + routes to the fresh
 * account via `selectSpawnAccount`. Fail-soft: any IO error → false (don't wedge admission on a bad
 * read — the per-account governor still paces each egress). An empty/≤1-account pool → false (the
 * single-credential governor pause governs, today's behavior).
 */
export async function accountRoutingExhausted(ws?: string, now = Date.now()): Promise<boolean> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool || pool.accounts.length <= 1) return false;
  return isClassExhausted(pool, now);
}

/**
 * Evaluate the fleet OPUS-BUDGET decision for a spawn of the given criticality (B-GW-4 —
 * inference-gateway-robustness-audit-2026-06-20 gateway P2). Loads the pool (fail-soft) and runs the
 * pure `evaluateOpusBudget` over the live per-account 5h/7d utilization projection. The caller
 * (operator-spawn) uses `decision.downgrade` to shed a non-critical OPUS escalation to sonnet,
 * pacing fleet opus to stay UNDER the 5h ceiling. Fail-soft: any IO error → an `admit` decision
 * (aggregateUtil null, downgrade false), so a bad pool read can never wedge or mis-route a spawn.
 */
export async function evaluateOpusBudgetForSpawn(
  criticality: WorkCriticality,
  ws?: string,
  now = Date.now(),
): Promise<OpusBudgetDecision> {
  const pool = await loadAccountPool(ws).catch(() => null);
  if (!pool) {
    return { aggregateUtil: null, headroom: null, zone: 'headroom', downgrade: false, pace: false, reason: 'opus budget: pool unreadable — admit (fail-soft)' };
  }
  return evaluateOpusBudget({ pool, criticality, now, policy: await readOpusBudgetPolicy() });
}

/**
 * Pick the account an IN-PROCESS anthropic-direct / Queen-brain call should egress through
 * (account-aware-rate-governor-routing Phase 2). The Queen-brain + in-process operator calls used to
 * all egress on the gateway's fixed `active()` account, hammering + 429-ing it → poisoning the global
 * opus bucket → freezing the fleet. Routing them through the SAME per-account pool selector spreads
 * that non-bee load (drain → fresh budget) and keeps a sticky/soft-pinned credential for cache warmth.
 * `key` is a stable logical identity (e.g. `'brain'` or an operator-session id) used as the cache-
 * affinity harness so repeat in-process calls reuse one credential. Returns the account id to stamp on
 * the `x-papercusp-account` header, or undefined (≤1 account / all full) → the gateway's active().
 */
export async function selectInProcessAccount(key: string, ws?: string, priorAccountId?: string): Promise<string | undefined> {
  return selectSpawnAccount(ws, key, priorAccountId);
}

/**
 * Read-modify-write the pool. Not a single PG transaction (the pool is a low-churn
 * PROJECTION — the governor is the rate-state source of truth — so a lost racing
 * penalty write self-heals on the next pause); deploy-time binds are single-caller.
 */
export async function updateAccountPool(
  mutator: (pool: AccountPool) => AccountPool,
  ws?: string,
): Promise<AccountPool> {
  const next = mutator(await loadAccountPool(ws));
  await saveAccountPool(next, ws);
  return next;
}

// ── P-020: deploy-time account selection ─────────────────────────────────────

export interface DeployAccountDeps {
  loadPool: (ws: string) => Promise<AccountPool>;
  savePool: (pool: AccountPool, ws: string) => Promise<void>;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export function defaultDeployAccountDeps(log?: (level: LogLevel, msg: string) => void): DeployAccountDeps {
  return { log, loadPool: (ws) => loadAccountPool(ws), savePool: (pool, ws) => saveAccountPool(pool, ws) };
}

/**
 * Bind an account to a member's deployment at deploy time (P-020). An explicit
 * `credentialRef` on the deployment wins (the user pinned a credential) and is
 * returned unchanged. Otherwise the most-available account is chosen, stamped onto
 * the deployment (`credentialRef` + `accountId`), and the slug bound in the pool.
 * An empty pool / no available account ⇒ the deployment is returned unchanged (the
 * frame falls back to its env/default credential — today's behavior).
 */
export async function selectAccountForDeploy(
  deployment: DeploymentConfig,
  slug: string,
  ws: string,
  deps: DeployAccountDeps = defaultDeployAccountDeps(),
): Promise<DeploymentConfig> {
  if (deployment.credentialRef) return deployment; // explicit pin wins
  const now = deps.now?.() ?? Date.now();
  const pool = await deps.loadPool(ws);
  // P-004: restrict deploy-time binding to the owner's session-now override (fail-soft,
  // no-op when unset). If the override leaves no candidate, `chosen` is undefined → the
  // deployment is returned unchanged (frame-default credential), exactly as an empty pool.
  const override = await readAccountOverride(ws);
  const candidatePool = isOverrideEmpty(override)
    ? pool
    : { accounts: pool.accounts.filter((a) => applyAccountOverride([a.id], override).length > 0) };
  const chosen = selectAccountByHeadroom(candidatePool, now, { preferUnbound: true });
  if (!chosen) {
    deps.log?.('info', `[accounts] pool has no available account — '${slug}' deploys on the frame default credential`);
    return deployment;
  }
  await deps.savePool(bindAccount(unbindAccount(pool, slug), chosen.id, slug), ws);
  deps.log?.('info', `[accounts] bound account '${chosen.id}' to '${slug}' by headroom`);
  return { ...deployment, credentialRef: chosen.credentialRef, accountId: chosen.id };
}

// ── P-021: scale-out reaction ────────────────────────────────────────────────

export interface ScaleOutDeps {
  loadPool: (ws: string) => Promise<AccountPool>;
  savePool: (pool: AccountPool, ws: string) => Promise<void>;
  /** The member's current cloud deployment template (target/region/size) to replicate. */
  memberDeployment: (slug: string, ws: string) => Promise<DeploymentConfig | undefined>;
  /** Provision a fresh frame for `slug` on `deployment` (real = repoint registry + deployHarness). */
  redeploy: (slug: string, ws: string, deployment: DeploymentConfig) => Promise<{ frame: Frame }>;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export interface ScaleOutMember {
  slug: string;
  frame?: Frame;
  error?: string;
}
export type ScaleOutResult =
  | { scaledOut: true; account: string; members: ScaleOutMember[] }
  | { scaledOut: false; reason: 'no-fresh-account' | 'not-sustained' | 'no-bound-members' };

/**
 * The P-021 reaction: when an account is exhausted, provision a fresh Swarm on a
 * fresh account for that account's bound members — instead of only pausing. Each
 * member's existing cloud deployment is replicated with the fresh account's
 * credential; the binding moves from the exhausted account to the fresh one. Pure
 * decision (`decideScaleOut`) + injected IO, so it's fully unit-testable; the real
 * `redeploy` provisions a machine (owner-gated, costs money).
 */
export async function handleAccountExhausted(
  exhaustedId: string,
  ws: string,
  deps: ScaleOutDeps,
  opts: { requireSustained?: boolean; policy?: ScalePolicy } = {},
): Promise<ScaleOutResult> {
  const now = deps.now?.() ?? Date.now();
  const pool = await deps.loadPool(ws);
  const decision = decideScaleOut(pool, exhaustedId, now, { ...opts, policy: opts.policy ?? (await readScalePolicy()) });
  if (!decision.provision) return { scaledOut: false, reason: decision.reason };

  const fresh = decision.account;
  const slugs = getAccount(pool, exhaustedId)?.boundTo ?? [];
  if (slugs.length === 0) return { scaledOut: false, reason: 'no-bound-members' };

  const members: ScaleOutMember[] = [];
  let next = pool;
  for (const slug of slugs) {
    const template = await deps.memberDeployment(slug, ws).catch(() => undefined);
    if (!template || template.target === 'local') {
      members.push({ slug, error: 'no cloud deployment template to replicate' });
      continue;
    }
    const deployment: DeploymentConfig = { ...template, credentialRef: fresh.credentialRef, accountId: fresh.id };
    try {
      const { frame } = await deps.redeploy(slug, ws, deployment);
      members.push({ slug, frame });
      next = bindAccount(unbindAccount(next, slug), fresh.id, slug);
      deps.log?.('info', `[accounts] scaled '${slug}' off '${exhaustedId}' → '${fresh.id}' on frame ${frame.id}`);
    } catch (e) {
      members.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  await deps.savePool(next, ws);
  return { scaledOut: true, account: fresh.id, members };
}

export function defaultScaleOutDeps(log?: (level: LogLevel, msg: string) => void): ScaleOutDeps {
  return {
    log,
    loadPool: (ws) => loadAccountPool(ws),
    savePool: (pool, ws) => saveAccountPool(pool, ws),
    async memberDeployment(slug, ws) {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(ws);
      return reg.projects.find((p) => p.slug === slug)?.deployment;
    },
    async redeploy(slug, ws, deployment) {
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const { deployHarness, teardownHarness, defaultDeployDeps } = await import('./deploy');
      const deployDeps = defaultDeployDeps(log);
      // Scale-out MOVES the member: destroy the exhausted account's frame first
      // (ends its billing; no-op when none). Skipping this would trip the
      // double-deploy guard — and before that guard existed it silently
      // overwrote the handle, orphaning the old frame's billing.
      await teardownHarness(slug, ws, deployDeps);
      const reg = await loadHarnessRegistry(ws);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p) {
        p.deployment = deployment; // repoint at the fresh-account swarm config first
        await saveHarnessRegistry(reg, ws);
      }
      // The fresh deployment already carries credentialRef → selectAccount is a no-op here.
      return deployHarness(slug, ws, deployDeps);
    },
  };
}

// ── P-019/P-021: governor-pause → account bridge ─────────────────────────────

export interface ScaleObserverDeps {
  workspaceId: () => string;
  now: () => number;
  updatePool: (mutator: (pool: AccountPool) => AccountPool, ws: string) => Promise<AccountPool>;
  scaleOut: (accountId: string, ws: string) => Promise<ScaleOutResult>;
  emitExhausted: (accountId: string, pausedUntil: number) => void;
  /** Owner auto-scale-out toggle gate (queen-steering-panel P-006): false ⇒ the
   *  owner has disabled automatic scale-out on the 👑 tab for the home hive, so an
   *  exhausted account is NOT auto-scaled (manual accounts:scale_out still works).
   *  Default reads owner-steering fail-soft → true (enabled). */
  autoScaleOutAllowed: (ws: string) => Promise<boolean>;
  log: (level: LogLevel, msg: string) => void;
}

function defaultEmitExhausted(accountId: string, pausedUntil: number): void {
  // Reuse the await-event primitive (the gym's `rate-limit:*` family) so anyone can
  // `events:await { event: 'rate-limit:exhausted:<id>' }`. Lazy + fire-and-forget.
  void import('../events/await/engine')
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: `rate-limit:exhausted:${accountId}`,
        summary: `account '${accountId}' sustainedly rate-limited — scale-out candidate`,
        payload: { accountId, pausedUntil },
        source: 'account-pool',
      }),
    )
    .catch(() => {
      /* visibility only — never break the limiter */
    });
}

let observerUnsub: (() => void) | undefined;

/**
 * Wire the governor's per-account pause signal into the pool (P-019) + the
 * auto-scale-out reaction (P-021). On a pause for an ACCOUNT-keyed bucket
 * (`<provider>:<modelClass>@<id>` — set when a process runs under
 * `PAPERCUSP_ACCOUNT_ID`), record the penalty into the pool projection; when that
 * tips the account into "sustainedly limited", emit `rate-limit:exhausted:<id>`
 * and attempt a scale-out. Global buckets (no accountId) are left to the existing
 * `agent-governor-observer` (coord/toast surfacing). Idempotent; call once at boot.
 */
export function initAccountScaleObserver(deps: Partial<ScaleObserverDeps> = {}): () => void {
  if (observerUnsub) return observerUnsub;
  const workspaceId = deps.workspaceId ?? (() => activeWorkspaceId());
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((lvl, m) => console.warn(`[accounts:${lvl}] ${m}`));
  const updatePool = deps.updatePool ?? updateAccountPool;
  const scaleOut = deps.scaleOut ?? ((id, ws) => handleAccountExhausted(id, ws, defaultScaleOutDeps(log)));
  const emitExhausted = deps.emitExhausted ?? defaultEmitExhausted;
  // Owner auto-scale-out toggle (queen-steering-panel P-006). Fail-soft → enabled.
  const autoScaleOutAllowed =
    deps.autoScaleOutAllowed ??
    (async (ws: string): Promise<boolean> => {
      try {
        const [{ getOwnerSteering, isAutoScaleOutEnabled }, { resolveHiveHomeSlug }] = await Promise.all([
          import('../owner-steering'),
          import('../hive/wake'),
        ]);
        const home = resolveHiveHomeSlug();
        return home ? isAutoScaleOutEnabled(await getOwnerSteering(ws, home)) : true;
      } catch {
        return true;
      }
    });

  observerUnsub = onGovernorPause((ev) => {
    const { accountId } = parseGovernorKey(ev.key);
    if (!accountId) return; // a global bucket — not an account pause
    const ws = workspaceId();
    const t = now();
    void (async () => {
      try {
        const pool = await updatePool(
          (p) => recordAccountPenalty(p, accountId, t, { pausedUntil: ev.pausedUntil }),
          ws,
        );
        const acct = getAccount(pool, accountId);
        if (!acct || !isSustainedlyLimited(acct, t, await readScalePolicy())) return; // not exhausted (yet) — just pausing
        emitExhausted(accountId, ev.pausedUntil); // observability fires regardless of the toggle
        // Owner auto-scale-out toggle (queen-steering-panel P-006): when disabled, the
        // account is left paused (no auto-deploy); manual accounts:scale_out still works.
        if (!(await autoScaleOutAllowed(ws))) {
          log(
            'info',
            `'${accountId}' sustainedly limited but auto-scale-out is DISABLED by owner steering — not scaling (manual accounts:scale_out still works)`,
          );
          return;
        }
        const r = await scaleOut(accountId, ws);
        if (r.scaledOut) {
          log('info', `auto-scaled '${accountId}' → '${r.account}' (${r.members.length} member(s))`);
        } else {
          log('info', `'${accountId}' sustainedly limited but no scale-out (${r.reason}) — pausing as before`);
        }
      } catch (e) {
        log('warn', `account-scale observer failed for '${accountId}': ${(e as Error).message}`);
      }
    })();
  });
  return observerUnsub;
}

/** Test-only — drop the subscription + reset. */
export function _resetAccountScaleObserver(): void {
  observerUnsub?.();
  observerUnsub = undefined;
}

// ── Status read-model (for accounts:status) ──────────────────────────────────

export interface AccountStatusRow {
  id: string;
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  rate: AccountRateState;
  /** Per-account egress pin (proxy / local source IP), if the account is IP-routed. */
  egress?: AccountEgress;
  /** Live governor buckets keyed to this account (present only if THIS process ran under it). */
  liveBuckets: { key: string; provider: string; modelClass: string; paused: boolean; pausedUntil: number }[];
}

/** Assemble the per-account status: the persisted projection + any live local governor buckets. */
export async function accountStatus(ws?: string, now = Date.now()): Promise<AccountStatusRow[]> {
  const pool = await loadAccountPool(ws);
  const live = snapshotGovernors();
  const scalePolicy = await readScalePolicy();
  return pool.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    credentialRef: a.credentialRef,
    boundTo: a.boundTo,
    available: isAvailable(a, now),
    sustainedlyLimited: isSustainedlyLimited(a, now, scalePolicy),
    rate: a.rate,
    egress: a.egress,
    liveBuckets: live
      .filter((b) => b.accountId === a.id)
      .map((b) => ({
        key: b.key,
        provider: b.provider,
        modelClass: b.modelClass,
        paused: b.state.pausedUntil > now,
        pausedUntil: b.state.pausedUntil,
      })),
  }));
}
