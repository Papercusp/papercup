/**
 * Operator daily budget cap (Phase 1c of the v5 operator plan).
 *
 * State shape on disk (`<papercuspRoot>/system/operator/budget.json`):
 *   {
 *     "dailyCapUsd": 20,             // Light=5, Active=20, Heavy=50
 *     "spend": [{ "date": "YYYY-MM-DD", "usd": 0.123 }, ...]  // last 7 days
 *   }
 *
 * The substrate has its own per-token budget machinery; this layer is
 * the operator-app-level UX cap (auto-pause on overrun + sizing prompt).
 * The two are independent — a strict substrate cap will trip first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { papercuspPath } from './papercusp-root';

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

function BUDGET_PATH() {
  return papercuspPath('system', 'operator', 'budget.json');
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns null when the user has not yet picked a sizing — UI shows the modal. */
export function loadBudget(): BudgetState | null {
  const path = BUDGET_PATH();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BudgetState>;
    if (!raw || typeof raw !== 'object' || typeof raw.dailyCapUsd !== 'number') return null;
    return {
      dailyCapUsd: raw.dailyCapUsd,
      spend: Array.isArray(raw.spend)
        ? raw.spend
            .filter((s): s is { date: string; usd: number } =>
              !!s && typeof s.date === 'string' && typeof s.usd === 'number')
            .slice(-7)
        : [],
    };
  } catch {
    return null;
  }
}

export function setBudget(dailyCapUsd: number): BudgetState {
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd <= 0) {
    throw new Error('dailyCapUsd must be a positive number');
  }
  const existing = loadBudget();
  const next: BudgetState = {
    dailyCapUsd,
    spend: existing?.spend ?? [],
  };
  writeBudget(next);
  return next;
}

function writeBudget(b: BudgetState): void {
  const path = BUDGET_PATH();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(b, null, 2));
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
export function checkBudget(): BudgetCheck {
  const state = loadBudget();
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
 */
export function recordSpend(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const state = loadBudget();
  if (!state) return;
  const today = todayIso();
  const idx = state.spend.findIndex((s) => s.date === today);
  if (idx >= 0) {
    state.spend[idx] = { date: today, usd: state.spend[idx].usd + usd };
  } else {
    state.spend = [...state.spend.slice(-6), { date: today, usd }];
  }
  writeBudget(state);
}
