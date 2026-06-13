/**
 * Operator daily budget cap (Phase 1c of the v5 operator plan).
 *
 * Persisted in `harness_shared.operator_budget` (PG, migration 020). The
 * payload shape:
 *   {
 *     "dailyCapUsd": 20,             // Light=5, Active=20, Heavy=50
 *     "spend": [{ "date": "YYYY-MM-DD", "usd": 0.123 }, ...]  // last 7 days
 *   }
 *
 * Read-modify-write goes through `updateOperatorState` so the cap-trip
 * detection runs on a transactionally-consistent read instead of a
 * potentially-stale file load.
 *
 * The substrate has its own per-token budget machinery; this layer is
 * the operator-app-level UX cap (auto-pause on overrun + sizing prompt).
 * The two are independent — a strict substrate cap will trip first.
 */

import {
  readOperatorState,
  writeOperatorState,
  updateOperatorState,
} from './operator-state-pg';

export type BudgetTier = 'light' | 'active' | 'heavy' | 'custom';

export interface BudgetState {
  dailyCapUsd: number;
  spend: { date: string; usd: number }[];
}

export const TIER_CAPS: Record<Exclude<BudgetTier, 'custom'>, number> = {
  light: 5,
  active: 20,
  heavy: 50,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns null when the user has not yet picked a sizing — UI shows the modal. */
export async function loadBudget(): Promise<BudgetState | null> {
  const raw = await readOperatorState<Partial<BudgetState>>('operator_budget');
  if (!raw || typeof raw.dailyCapUsd !== 'number') return null;
  return {
    dailyCapUsd: raw.dailyCapUsd,
    spend: Array.isArray(raw.spend)
      ? raw.spend
          .filter((s): s is { date: string; usd: number } =>
            !!s && typeof s.date === 'string' && typeof s.usd === 'number')
          .slice(-7)
      : [],
  };
}

export async function setBudget(dailyCapUsd: number): Promise<BudgetState> {
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) {
    throw new Error('dailyCapUsd must be a positive number');
  }
  const existing = await loadBudget();
  const next: BudgetState = {
    dailyCapUsd,
    spend: existing?.spend ?? [],
  };
  await writeOperatorState('operator_budget', next);
  // queen-autonomy P-112: route the budget decision through the disposition log
  // (spend-budget category, owner-authority). Fire-and-forget + flag-gated — a
  // logging miss must never break a budget write.
  void (async () => {
    try {
      const [{ recordProactiveDisposition }, { activeWorkspaceId }] = await Promise.all([
        import('./decision-ledger/disposition'),
        import('./workspace-registry'),
      ]);
      await recordProactiveDisposition({
        workspaceId: activeWorkspaceId(),
        decisionInput: {
          action: 'operator:budget',
          riskTier: 'high',
          authority: 'owner',
          reversibility: 'reversible',
        },
        why: `daily budget cap ${existing?.dailyCapUsd != null ? `$${existing.dailyCapUsd}` : 'unset'} → $${dailyCapUsd}`,
        metadata: { previousCapUsd: existing?.dailyCapUsd ?? null, dailyCapUsd },
      });
    } catch {
      /* never break a budget write on a ledger miss */
    }
  })();
  return next;
}

export interface BudgetCheck {
  /** True when today's spend already meets-or-exceeds the cap. */
  exceeded: boolean;
  todaySpendUsd: number;
  capUsd: number;
  /** Null when no budget configured. */
  state: BudgetState | null;
}

/**
 * Read the current spend posture without mutating. Callers gate scan
 * spawn on `!check.exceeded`. Auto-pause is applied by the panel.
 */
export async function checkBudget(): Promise<BudgetCheck> {
  const state = await loadBudget();
  if (!state) return { exceeded: false, todaySpendUsd: 0, capUsd: 0, state: null };
  const today = todayIso();
  const entry = state.spend.find((s) => s.date === today);
  const todaySpendUsd = entry?.usd ?? 0;
  return {
    exceeded: todaySpendUsd >= state.dailyCapUsd,
    todaySpendUsd,
    capUsd: state.dailyCapUsd,
    state,
  };
}

/**
 * Add spend for today. Called from the operator-scan route on `result`.
 * Does nothing when no budget configured (we don't want to silently
 * accumulate before the user has agreed to a cap).
 *
 * Atomic: read-modify-write happens inside a single PG transaction so
 * concurrent scans on multiple tabs each get their full spend recorded.
 */
export async function recordSpend(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  await updateOperatorState<BudgetState | { dailyCapUsd: undefined; spend: never[] }>(
    'operator_budget',
    { dailyCapUsd: undefined as unknown as number, spend: [] },
    (cur) => {
      // Skip if no budget is configured — same semantic as the file path.
      if (!cur || typeof (cur as BudgetState).dailyCapUsd !== 'number') return cur as BudgetState;
      const state = cur as BudgetState;
      const today = todayIso();
      const idx = state.spend.findIndex((s) => s.date === today);
      const nextSpend = [...state.spend];
      if (idx >= 0) {
        nextSpend[idx] = { date: today, usd: nextSpend[idx].usd + usd };
      } else {
        nextSpend.push({ date: today, usd });
      }
      return { ...state, spend: nextSpend.slice(-7) };
    },
  );
}
