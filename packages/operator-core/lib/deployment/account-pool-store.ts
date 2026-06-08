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
import { onGovernorPause, parseGovernorKey, snapshotGovernors } from '@papercusp/papercup-shared/agent';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import {
  type AccountPool,
  type AccountRateState,
  type ScalePolicy,
  bindAccount,
  decideScaleOut,
  getAccount,
  isAvailable,
  isSustainedlyLimited,
  recordAccountPenalty,
  selectAccountByHeadroom,
  unbindAccount,
} from './account-pool';

// ── Persistence (operator-state idiom) ───────────────────────────────────────

export async function loadAccountPool(ws?: string): Promise<AccountPool> {
  const raw = await readOperatorState<AccountPool>('operator_account_pool', ws);
  return { accounts: raw?.accounts ?? [] };
}

export async function saveAccountPool(pool: AccountPool, ws?: string): Promise<void> {
  await writeOperatorState('operator_account_pool', { accounts: pool.accounts }, ws);
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
  const chosen = selectAccountByHeadroom(pool, now, { preferUnbound: true });
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
  const decision = decideScaleOut(pool, exhaustedId, now, opts);
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
      const { deployHarness, defaultDeployDeps } = await import('./deploy');
      const reg = await loadHarnessRegistry(ws);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p) {
        p.deployment = deployment; // repoint at the fresh-account swarm config first
        await saveHarnessRegistry(reg, ws);
      }
      // The fresh deployment already carries credentialRef → selectAccount is a no-op here.
      return deployHarness(slug, ws, defaultDeployDeps(log));
    },
  };
}

// ── P-019/P-021: governor-pause → account bridge ─────────────────────────────

export interface ScaleObserverDeps {
  workspaceId: () => string;
  now: () => number;
  scaleOut: (accountId: string, ws: string) => Promise<ScaleOutResult>;
  emitExhausted: (accountId: string, pausedUntil: number) => void;
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
  const scaleOut = deps.scaleOut ?? ((id, ws) => handleAccountExhausted(id, ws, defaultScaleOutDeps(log)));
  const emitExhausted = deps.emitExhausted ?? defaultEmitExhausted;

  observerUnsub = onGovernorPause((ev) => {
    const { accountId } = parseGovernorKey(ev.key);
    if (!accountId) return; // a global bucket — not an account pause
    const ws = workspaceId();
    const t = now();
    void (async () => {
      try {
        const pool = await updateAccountPool(
          (p) => recordAccountPenalty(p, accountId, t, { pausedUntil: ev.pausedUntil }),
          ws,
        );
        const acct = getAccount(pool, accountId);
        if (!acct || !isSustainedlyLimited(acct, t)) return; // not exhausted (yet) — just pausing
        emitExhausted(accountId, ev.pausedUntil);
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
  /** Live governor buckets keyed to this account (present only if THIS process ran under it). */
  liveBuckets: { key: string; provider: string; modelClass: string; paused: boolean; pausedUntil: number }[];
}

/** Assemble the per-account status: the persisted projection + any live local governor buckets. */
export async function accountStatus(ws?: string, now = Date.now()): Promise<AccountStatusRow[]> {
  const pool = await loadAccountPool(ws);
  const live = snapshotGovernors();
  return pool.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    credentialRef: a.credentialRef,
    boundTo: a.boundTo,
    available: isAvailable(a, now),
    sustainedlyLimited: isSustainedlyLimited(a, now),
    rate: a.rate,
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
