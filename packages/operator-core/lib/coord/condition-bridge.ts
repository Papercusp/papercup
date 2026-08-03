/**
 * condition-bridge.ts — P-003 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * The reconciler that turns a CONDITION into a claimable OBJECT: when an
 * actionable condition opens, mint (at most) one owning work-item; when it
 * resolves, release the key so a future occurrence can mint a fresh one.
 *
 * ONE bridge, not per-watchdog wiring. There are 12 `conditionKey` producers
 * (`green-stall:<slug>`, `main-behind-staging:<slug>`, `single-primary:<verdict>`,
 * `release-trigger-freeze:<slug>`, ...). Wiring each to file its own work-item is
 * how the ad-hoc versions got built four times already (see D-002) and how they
 * drifted. Every producer inherits this one instead.
 *
 * ── WHY THE RACE IS SAFE, AND WHY THAT IS THE POINT ────────────────────────────
 * Two hosts can observe the same condition open simultaneously. The claim here is
 * deliberately optimistic — create, then try to take the key — because migration
 * 741's PARTIAL UNIQUE INDEX serializes the winner in Postgres. The loser gets a
 * unique violation, stands down, and adopts the winner's item.
 *
 * That is the whole thesis of D-002 stated as code: WI-6986 implemented this same
 * dedup as a QUERY ("is there already one?") and raced, duplicating "40 of 88 open
 * rows" cross-machine. A check-then-act cannot be made safe by checking harder; a
 * unique index needs no check at all.
 *
 * ── OPENNESS IS `status`, NEVER `closed_ts` ───────────────────────────────────
 * See D-010 and condition-object.ts's header. `closed_ts` is NULL on 100% of
 * `closed` rows and 77-99% of the other terminals — it is a best-effort precision
 * stamp, not a lifecycle field. Every terminal test here derives from
 * `ANY_FAMILY_TERMINAL_STATES`; no status vocabulary is re-listed.
 *
 * ── SELF-HEALING ──────────────────────────────────────────────────────────────
 * Release is a write, and writes can be missed (a crash between settling an item
 * and clearing its key). So `acquireConditionOwner` FIRST clears the key from any
 * already-terminal row holding it. A missed release therefore costs one extra
 * cycle, not a permanently unownable condition — which is the failure mode D-010
 * was written to eliminate, restated at the layer that can actually violate it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { createWorkItem, setWorkItemState } from '../work-items';
import { findConditionObject, linkWorkItemToCondition, type ConditionObject } from './condition-object';

/**
 * Condition-key PREFIXES that may mint an owning work-item.
 *
 * OPT-IN, deliberately. A transient condition that opens and clears within a tick
 * would otherwise mint and immediately close a work-item on every flap, which is
 * strictly worse than the duplicate-filing problem this plan set out to fix.
 *
 * ⚠ The plan item said "opt-in per key via the signal-actor registry
 * (`actionable: true`)". That field does not exist — `signal-actor-registry.ts`
 * registers SIGNALS (4 of them) with `actingConsumer`/`waiver`, which is a
 * different granularity and a different question ("does anything act on this
 * stream?" vs "should THIS key own an item?"). Rather than bend that registry to
 * a shape it was not built for, the opt-in lives here, in the same small
 * manually-curated-catalog style that registry itself uses and for the same
 * stated reason: what counts is not mechanically decidable.
 *
 * A prefix earns a place here when the condition is (a) durable enough that a
 * human or agent would want to claim it, and (b) actionable — there is something
 * to DO. Everything else is intentionally absent.
 */
export interface ActionableCondition {
  /** Key prefix, always ending in ':'. */
  prefix: string;
  /**
   * How to get the HARNESS this condition belongs to.
   *
   * ⚠ This field exists because the obvious shortcut is wrong and fails SILENTLY.
   * Four of the five producers below suffix the key with the harness slug
   * (`green-stall:${row.install_slug}`, `main-behind-staging:${harnessSlug}`,
   * `release-trigger-freeze:${installSlug}`, `release-trigger-fire-stale:${installSlug}`)
   * — but `single-primary:` does NOT: it is `single-primary:${verdict.key}`, and
   * the live key is `single-primary:no-primary`. `no-primary` is a VERDICT.
   *
   * A `key.split(':')[1]` harness derivation therefore files that condition's
   * work-item under harness `no-primary`, and `createWorkItem` does NOT validate
   * the harness — it just builds `scope: harnessScope(input.harness)`. The row is
   * created successfully, scoped to a harness nobody queries, and is invisible to
   * `work_items:list { harness }` forever. Same class as D-010: a plausible
   * derivation that produces an unreachable row and never errors.
   *
   * 'suffix'  = the text after the prefix IS the harness slug.
   * 'ambient' = the key carries no harness; the caller must supply one.
   */
  harnessFrom: 'suffix' | 'ambient';
  severity: 'critical' | 'major' | 'minor' | 'nit';
}

/**
 * The opt-in catalog. See the doc above for why `harnessFrom` is explicit
 * per-entry rather than parsed.
 */
export const ACTIONABLE_CONDITIONS: readonly ActionableCondition[] = [
  { prefix: 'green-stall:', harnessFrom: 'suffix', severity: 'critical' },
  { prefix: 'main-behind-staging:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'release-trigger-freeze:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'release-trigger-fire-stale:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'single-primary:', harnessFrom: 'ambient', severity: 'critical' },
];

/** The bare prefixes — derived, so the catalog stays the single source of truth. */
export const ACTIONABLE_CONDITION_PREFIXES: readonly string[] = ACTIONABLE_CONDITIONS.map((c) => c.prefix);

/** The catalog entry governing this key, or null when it is not opted in. */
export function actionableConditionFor(conditionKey: string): ActionableCondition | null {
  const key = conditionKey.trim();
  if (!key) return null;
  return ACTIONABLE_CONDITIONS.find((c) => key.startsWith(c.prefix)) ?? null;
}

/** Should this condition key mint an owning work-item? */
export function isActionableConditionKey(conditionKey: string): boolean {
  return actionableConditionFor(conditionKey) !== null;
}

/**
 * Which harness owns this condition — or null when it cannot be established.
 *
 * FAIL-CLOSED on purpose: returning null makes the caller SKIP the condition,
 * which costs one un-owned condition. Guessing instead costs a work-item filed
 * into a harness that does not exist, which nothing surfaces and nobody sees.
 */
export function resolveConditionHarness(
  conditionKey: string,
  ambientHarness?: string | null,
): string | null {
  const key = conditionKey.trim();
  const entry = actionableConditionFor(key);
  if (!entry) return null;
  if (entry.harnessFrom === 'ambient') return ambientHarness?.trim() || null;
  const suffix = key.slice(entry.prefix.length).trim();
  // A suffix carrying further ':' segments is not a bare slug — don't guess.
  return suffix && !suffix.includes(':') ? suffix : ambientHarness?.trim() || null;
}

/** PURE. Is this status settled? Derived from the shared SSOT, never re-listed. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && ANY_FAMILY_TERMINAL_STATES.includes(status);
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

export interface ConditionOwnerSpec {
  /** Work-item title (usually the condition's own alarm summary). */
  title: string;
  /** Body text — what opened, the evidence, what to do. */
  summary?: string;
  harness: string;
  workspaceId?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
}

export interface AcquireResult {
  conditionKey: string;
  /** The work-item that owns the condition after this call. */
  workItem: string | null;
  /** True when THIS call minted it. False = adopted an existing owner (incl. losing a race). */
  created: boolean;
  /** Set when we minted an item, lost the claim race, and stood down. */
  lostRaceTo?: string;
  /** Set when the key is not opted in (nothing was written). */
  skipped?: 'not-actionable';
}

/**
 * Clear `condition_key` from any row holding it that has already SETTLED.
 *
 * The self-heal described in the header. Returns how many rows were released, so
 * a caller can log a missed release rather than let it pass silently — a nonzero
 * count here means some earlier release did not run, which is worth knowing.
 */
export async function releaseStaleConditionKeys(conditionKey: string, workspaceId?: string): Promise<number> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET condition_key = NULL
     WHERE condition_key = ${conditionKey}
       AND status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
       AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
    RETURNING feature_id`;
  return rows.length;
}

/**
 * Try to take `conditionKey` for an existing work-item.
 *
 * Returns false when another row already holds it (the unique index refused us).
 * The `condition_key IS NULL` guard keeps this idempotent: re-claiming a key we
 * already hold is a no-op rather than an error.
 */
export async function claimConditionKey(
  workItemId: string,
  conditionKey: string,
  workspaceId?: string,
): Promise<boolean> {
  const sql = getOrgPg().sql;
  try {
    const rows = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET condition_key = ${conditionKey}
       WHERE feature_id = ${workItemId}
         AND condition_key IS NULL
         AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
      RETURNING feature_id`;
    return rows.length > 0;
  } catch (err) {
    // Expected under a cross-host race — the index did its job.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Ensure an actionable condition has exactly one owning work-item.
 *
 * Idempotent: calling it repeatedly while the condition stays open adopts the
 * existing owner and writes nothing.
 */
export async function acquireConditionOwner(
  conditionKey: string,
  spec: ConditionOwnerSpec,
): Promise<AcquireResult> {
  const key = conditionKey.trim();
  if (!isActionableConditionKey(key)) {
    return { conditionKey: key, workItem: null, created: false, skipped: 'not-actionable' };
  }

  // 1. Self-heal a missed release BEFORE looking for an owner, or a settled row
  //    would look like a live one and this condition could never be re-owned.
  await releaseStaleConditionKeys(key, spec.workspaceId);

  // 2. Already owned? Adopt it.
  const existing = await findConditionObject(key, { harnessSlug: spec.harness });
  if (existing.workItem) return { conditionKey: key, workItem: existing.workItem, created: false };

  // 3. Mint, then try to take the key. Deliberately optimistic — see the header.
  const item = await createWorkItem({
    kind: 'bug',
    title: spec.title,
    summary: spec.summary,
    harness: spec.harness,
    severity: spec.severity ?? 'major',
    workspaceId: spec.workspaceId,
    // Stamp the mint so `releaseConditionOwner` can tell an INCIDENT item (safe to
    // auto-settle) from a hand-filed ROOT-CAUSE item that merely holds the same key.
    // See BRIDGE_MINT_MARKER.
    payload: { [BRIDGE_MINT_MARKER]: { conditionKey: key, mintedAt: new Date().toISOString() } },
  } as Parameters<typeof createWorkItem>[0]);

  const won = await claimConditionKey(item.id, key, spec.workspaceId);
  if (!won) {
    // A peer won the race. Stand down: settle our row so it does not become the
    // very duplicate this plan exists to prevent, and adopt the winner.
    const winner = await findConditionObject(key, { harnessSlug: spec.harness });
    await setWorkItemState(item.id, 'dropped', {
      harness: spec.harness,
      completionRef: `superseded by ${winner.workItem ?? 'the concurrent owner'} — lost the condition-key claim race for '${key}'`,
    }).catch(() => undefined);
    return {
      conditionKey: key,
      workItem: winner.workItem,
      created: false,
      lostRaceTo: winner.workItem ?? undefined,
    };
  }

  // 4. Record the durable association too. The link is append-only history; the
  //    column is current ownership. Best-effort: a failed link must not orphan a
  //    successful claim (the claim is the load-bearing half).
  await linkWorkItemToCondition(item.id, key, { harness: spec.harness }).catch(() => undefined);

  return { conditionKey: key, workItem: item.id, created: true };
}

/**
 * Payload key stamping an item the BRIDGE MINTED (EI-19395923444306887).
 *
 * The distinction it encodes is the whole point, and it is not visible from the
 * `condition_key` column alone:
 *
 *   - an INCIDENT item (bridge-minted) means "this condition is open right now".
 *     Its lifetime IS the condition's, so auto-settling it on resolve is correct.
 *   - a ROOT-CAUSE item (hand-filed) means "this detector/subsystem is defective".
 *     It OUTLIVES the condition, so auto-settling it is destructive.
 *
 * A condition resolving is not the same event as the bug being fixed:
 * `single-primary:no-primary` clearing means a background primary is running
 * again, and says nothing about the guard defect that let the alarm fail to stand
 * down. Without this marker, `releaseConditionOwner({ settle: true })` closes
 * WHATEVER row holds the key — so backfilling `condition_key` onto a hand-filed
 * root-cause bug (an attractive cleanup, with ~6 `single-primary:no-primary`
 * filings sitting there inviting it) would let a transient recovery silently
 * close a documented bug on the reconciler's 5-minute cadence.
 *
 * Stamping makes that adoption SAFE rather than merely forbidden, which is the
 * better property: the idea is genuinely attractive and will be re-proposed, and
 * a documented prohibition only works on people who read the document.
 */
export const BRIDGE_MINT_MARKER = '_bridge';

export interface ReleaseResult {
  conditionKey: string;
  released: string | null;
  /** True when the owning item was also settled by this call. */
  settled: boolean;
  /**
   * Set when `settle: true` was asked for but deliberately NOT honored. Today the
   * only reason is `not-bridge-minted`: the key was released (so the next
   * occurrence mints fresh) while the hand-filed item it was on stays OPEN.
   *
   * Reported rather than silent — a caller that asked to settle and did not gets
   * to see why, instead of inferring it from `settled: false`.
   */
  settleSkipped?: 'not-bridge-minted';
}

/**
 * The condition resolved — release its key so a future occurrence mints fresh.
 *
 * `settle` closes the owning work-item as well. Default false: a condition
 * clearing does not always mean the work is finished (a gate that goes green on
 * its own may still deserve a post-mortem), so releasing the KEY and settling the
 * ITEM are kept separate decisions.
 *
 * ⚠ `settle: true` is HONORED ONLY for an item the bridge minted. A hand-filed
 * root-cause bug that holds this key is released but left OPEN, reported as
 * `settleSkipped: 'not-bridge-minted'`. See {@link BRIDGE_MINT_MARKER} — the key
 * releasing and the bug being fixed are different events.
 */
export async function releaseConditionOwner(
  conditionKey: string,
  opts: { harness?: string; workspaceId?: string; settle?: boolean; reason?: string } = {},
): Promise<ReleaseResult> {
  const key = conditionKey.trim();
  const current = await findConditionObject(key, { harnessSlug: opts.harness });
  if (!current.workItem) {
    // Still sweep terminal holders — a settled row may hold the key even when no
    // LIVE owner exists, and leaving it there blocks the next occurrence.
    await releaseStaleConditionKeys(key, opts.workspaceId);
    return { conditionKey: key, released: null, settled: false };
  }

  // Settle ONLY an item the bridge itself minted. A hand-filed root-cause bug can
  // legitimately hold this key (adopting one instead of minting a duplicate is the
  // obvious cleanup), and closing it because the CONDITION cleared would destroy a
  // documented finding on a 5-minute cadence — see BRIDGE_MINT_MARKER.
  let settled = false;
  let settleSkipped: ReleaseResult['settleSkipped'];
  if (opts.settle) {
    if (await isBridgeMinted(current.workItem, opts.workspaceId)) {
      await setWorkItemState(current.workItem, 'done', {
        harness: opts.harness,
        completionRef: opts.reason ?? `condition '${key}' resolved`,
      }).catch(() => undefined);
      settled = true;
    } else {
      // Release the key below (so the next occurrence mints fresh) but leave the
      // item OPEN. Fails SAFE: an unreadable payload reads as not-bridge-minted, so
      // the failure mode is a stale-open incident item, never a destroyed bug report.
      settleSkipped = 'not-bridge-minted';
    }
  }

  const sql = getOrgPg().sql;
  await sql`
    UPDATE harness_shared.work_items
       SET condition_key = NULL
     WHERE condition_key = ${key}
       AND (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null})`;

  return { conditionKey: key, released: current.workItem, settled, ...(settleSkipped ? { settleSkipped } : {}) };
}

/**
 * Was this work-item MINTED by the bridge (as opposed to hand-filed and merely
 * holding the key)?
 *
 * FAILS SAFE to `false`: an unreadable payload, a missing row, or a store error
 * all read as "not bridge-minted", so the worst outcome is an incident item left
 * open for a human to close — never a hand-filed root-cause bug auto-closed by a
 * transient recovery. The asymmetry is deliberate; the two errors are not
 * comparable in cost.
 */
export async function isBridgeMinted(workItem: string, workspaceId?: string): Promise<boolean> {
  try {
    const sql = getOrgPg().sql;
    const rows = await sql<{ minted: boolean }[]>`
      SELECT (payload -> ${BRIDGE_MINT_MARKER}) IS NOT NULL AS minted
        FROM harness_shared.work_items
       WHERE feature_id = ${workItem}
         AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
       LIMIT 1`;
    return rows[0]?.minted === true;
  } catch {
    return false;
  }
}

/** One condition as the bridge sees it. */
export interface ConditionState {
  conditionKey: string;
  open: boolean;
  title: string;
  summary?: string;
  harness: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
}

export interface ReconcileSummary {
  acquired: AcquireResult[];
  released: ReleaseResult[];
  skipped: number;
}

/**
 * Reconcile a batch of condition states — the tick body.
 *
 * Fail-soft per condition: one bad key must not abort the sweep, or a single
 * malformed condition would stop every other condition from being owned.
 *
 * ── WHY RESOLVE MUST SETTLE THE ITEM, NOT JUST RELEASE THE KEY ────────────────
 * `releaseConditionOwner` defaults `settle:false` — releasing the KEY and closing
 * the ITEM are separate decisions for a caller that wants a post-mortem. For THIS
 * caller they are not separable, and defaulting them apart is a work-item leak:
 *
 *   open -> mint WI-A ; resolve -> release key, WI-A STAYS OPEN ;
 *   re-open -> mint WI-B ; resolve -> ... WI-B stays open ; ...
 *
 * i.e. one permanently-open work-item per EPISODE — which is exactly the
 * duplicate-filing problem this plan exists to eliminate, reintroduced through
 * the exit path. It bites hardest on a flapping condition, and the actionable set
 * contains a measured flapper: `main-behind-staging:papercusp` resolved 15:45Z and
 * re-opened 18:30Z on 2026-08-02 alone (40 alarms). P-003's own text is explicit —
 * "condition opens -> upsert the singleton work-item; condition resolves -> CLOSE
 * IT" — so the singleton guarantee is only true if the close actually happens.
 *
 * That `settle: true` is SAFE here only because the close is scoped to items the
 * bridge minted ({@link BRIDGE_MINT_MARKER}). The two constraints read as opposites
 * and are not: this caller must close the INCIDENT item it created, and must never
 * close a hand-filed ROOT-CAUSE item that happens to hold the same key. The marker
 * is what makes "always settle on resolve" and "never auto-close someone's bug
 * report" simultaneously true.
 */
export async function reconcileConditions(
  states: readonly ConditionState[],
  opts: { workspaceId?: string } = {},
): Promise<ReconcileSummary> {
  const out: ReconcileSummary = { acquired: [], released: [], skipped: 0 };
  for (const s of states) {
    const entry = actionableConditionFor(s.conditionKey);
    if (!entry) {
      out.skipped += 1;
      continue;
    }
    try {
      if (s.open) {
        out.acquired.push(
          await acquireConditionOwner(s.conditionKey, {
            title: s.title,
            summary: s.summary,
            harness: s.harness,
            severity: s.severity ?? entry.severity,
            workspaceId: opts.workspaceId,
          }),
        );
      } else {
        out.released.push(
          await releaseConditionOwner(s.conditionKey, {
            harness: s.harness,
            workspaceId: opts.workspaceId,
            settle: true,
            reason: `condition '${s.conditionKey}' resolved — closed by the condition bridge`,
          }),
        );
      }
    } catch {
      // Swallow per-condition; the next tick retries. Nothing here is the last
      // chance to act on a condition.
    }
  }
  return out;
}

export type { ConditionObject };
