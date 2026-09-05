/**
 * throttle-recovery-ladder.test.ts — unit goldens for the lane-neutral outer
 * recovery ladder (plan `codex-429-recovery-and-routing-2026-09-01`, P-009).
 *
 * Each case transcribes a behaviour the LIVE Claude ladder exhibits at its
 * `downstream.start` decision seam, so the extraction is provably the same
 * decision table the handler ran inline. The integration-level proof stays
 * with each lane's own suite (gateway-claude-ladder.test.ts, gateway.test.ts,
 * gateway-openai-proxy.test.ts); these pin the pure decision.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  decideThrottleRecovery,
  shapeTerminalThrottle,
  type ThrottleLadderBudgets,
  type ThrottleLadderState,
} from './throttle-recovery-ladder';

const NOW = 1_700_000_000_000;

/** The Claude lane's live tuning (gateway.ts constants), used as the test rig. */
const BUDGETS: ThrottleLadderBudgets = {
  waitCapMs: 20_000, // ALL_THROTTLED_RECOVERY_WAIT_CAP_MS
  transientTotalWaitBudgetMs: 30_000, // TRANSIENT_TOTAL_WAIT_BUDGET_MS
  overloadBackoffMs: 1_000, // OVERLOAD_529_BACKOFF_MS
};

const state = (over: Partial<ThrottleLadderState> = {}): ThrottleLadderState => ({
  transientWaitedMs: 0,
  retryDeadlineAt: NOW + 60_000,
  absorbDeadlineAt: NOW + 120_000,
  headersSent: false,
  ...over,
});

const decide = (over: {
  status?: number;
  retryIntent?: boolean;
  lastExhaustResetAt?: number;
  poolRecoveryAt?: number;
  state?: Partial<ThrottleLadderState>;
}) =>
  decideThrottleRecovery({
    status: over.status ?? 429,
    retryIntent: over.retryIntent ?? true,
    lastExhaustResetAt: over.lastExhaustResetAt ?? 0,
    ...(over.poolRecoveryAt === undefined ? {} : { poolRecoveryAt: over.poolRecoveryAt }),
    state: state(over.state),
    budgets: BUDGETS,
    now: NOW,
  });

// ── rung (1): bounded transient wait ────────────────────────────────────────

test('a reset within the cap is waited out on the slot', () => {
  const d = decide({ lastExhaustResetAt: NOW + 5_000 });
  assert.deepEqual(d, { action: 'wait', waitMs: 5_000, transient: true });
});

test('the wait never crosses the wedge-prevention deadline', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 15_000,
    state: { retryDeadlineAt: NOW + 3_000 },
  });
  assert.deepEqual(d, { action: 'wait', waitMs: 3_000, transient: true });
});

test('a spent wait budget forecloses rung (1) and falls to the absorb', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 5_000,
    state: { transientWaitedMs: 28_000 }, // 28s + 5s > 30s budget
  });
  assert.equal(d.action, 'absorb');
  assert.equal(d.transient, true);
});

test('a reset already in the past yields waitMs 0 → rung (1) declines, absorb catches', () => {
  const d = decide({ lastExhaustResetAt: NOW - 1 });
  assert.equal(d.action, 'absorb');
  // A just-past reset is still TRANSIENT (the account is recovering right now).
  assert.equal(d.transient, true);
});

test('an unknown reset (0) is not transient — no blind wait', () => {
  const d = decide({ lastExhaustResetAt: 0, state: { absorbDeadlineAt: 0 } });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

// ── rung (2): extended absorption ───────────────────────────────────────────

test('ALL-WALLED FAIL-FAST: a multi-hour wall skips the wait and absorbs (if open)', () => {
  const d = decide({ lastExhaustResetAt: NOW + 3 * 3600_000 });
  assert.deepEqual(d, { action: 'absorb', backoffMs: 0, transient: false });
});

test('a 529 overload absorbs WITH the backoff (nothing rate-paused the account)', () => {
  const d = decide({ status: 529, lastExhaustResetAt: NOW + 3 * 3600_000 });
  assert.deepEqual(d, { action: 'absorb', backoffMs: 1_000, transient: false });
});

test('a written response head forecloses the absorb', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 3 * 3600_000,
    state: { headersSent: true },
  });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

test('an absorb budget of 0 means the absorb is off', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 3 * 3600_000,
    state: { absorbDeadlineAt: 0 },
  });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

test('a passed absorb deadline forecloses the absorb', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 3 * 3600_000,
    state: { absorbDeadlineAt: NOW - 1 },
  });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

// ── rung (2) × the pool recovery horizon (codex-auto-route-all-walled-fail-fast-2026-09-05) ──

test('ALL-WALLED FAIL-FAST: a pool horizon PAST the absorb deadline forwards instead of absorbing', () => {
  // The failed account's own reset is hours out AND the pool's earliest recovery is 3h out —
  // sleeping the 2-minute absorb budget cannot find capacity, so fail fast.
  const d = decide({
    lastExhaustResetAt: NOW + 3 * 3600_000,
    poolRecoveryAt: NOW + 3 * 3600_000,
  });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

test('a pool horizon INSIDE the absorb deadline still absorbs', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 3 * 3600_000,
    poolRecoveryAt: NOW + 90_000, // a sibling's park expires in 90s, budget is 120s
  });
  assert.deepEqual(d, { action: 'absorb', backoffMs: 0, transient: false });
});

test('a pool horizon of 0 (some account can serve now) absorbs — the re-pick will find it', () => {
  const d = decide({ lastExhaustResetAt: NOW + 3 * 3600_000, poolRecoveryAt: 0 });
  assert.deepEqual(d, { action: 'absorb', backoffMs: 0, transient: false });
});

test('an UNKNOWN pool horizon (Infinity) never absorbs', () => {
  const d = decide({ lastExhaustResetAt: NOW + 3 * 3600_000, poolRecoveryAt: Infinity });
  assert.deepEqual(d, { action: 'forward', transient: false });
});

test('a horizon exactly AT the absorb deadline is still inside the budget', () => {
  const d = decide({ lastExhaustResetAt: NOW + 3 * 3600_000, poolRecoveryAt: NOW + 120_000 });
  assert.equal(d.action, 'absorb');
});

test('the horizon gates the ABSORB only: a transient wait on the same slot is unaffected', () => {
  const d = decide({ lastExhaustResetAt: NOW + 5_000, poolRecoveryAt: NOW + 3 * 3600_000 });
  assert.deepEqual(d, { action: 'wait', waitMs: 5_000, transient: true });
});

test('omitting the horizon preserves the pre-horizon goldens exactly', () => {
  assert.deepEqual(decide({ lastExhaustResetAt: NOW + 3 * 3600_000 }), {
    action: 'absorb',
    backoffMs: 0,
    transient: false,
  });
});

// ── rung (3): forward ───────────────────────────────────────────────────────

test('retryIntent false is always a forward, transient still reported', () => {
  const d = decide({ retryIntent: false, lastExhaustResetAt: NOW + 5_000 });
  assert.deepEqual(d, { action: 'forward', transient: true });
});

test('everything spent → forward (plain exhaustion, transient true)', () => {
  const d = decide({
    lastExhaustResetAt: NOW + 5_000,
    state: { transientWaitedMs: 29_000, absorbDeadlineAt: NOW - 1 },
  });
  assert.deepEqual(d, { action: 'forward', transient: true });
});

// ── terminal shaping ────────────────────────────────────────────────────────

const EXHAUSTED = 'x-papercusp-retries-exhausted';

test('codex shaping: dialect reset drives a capped retry-after + exhausted marker', () => {
  const s = shapeTerminalThrottle({
    attempts: 3,
    retriesExhaustedHeader: EXHAUSTED,
    retryAfter: { resetAt: NOW + 10_000, fallbackSec: 5, capS: 60 },
    now: NOW,
  });
  assert.deepEqual(s.headers, { [EXHAUSTED]: '3', 'retry-after': '10' });
  assert.equal(s.retryAfterSec, 10);
});

test('codex shaping: no reset known → the fallback floor', () => {
  const s = shapeTerminalThrottle({
    attempts: 1,
    retriesExhaustedHeader: EXHAUSTED,
    retryAfter: { resetAt: null, fallbackSec: 5, capS: 60 },
    now: NOW,
  });
  assert.equal(s.headers['retry-after'], '5');
});

test('codex shaping: a weekly wall is CAPPED so the bee re-asks soon', () => {
  const s = shapeTerminalThrottle({
    attempts: 2,
    retriesExhaustedHeader: EXHAUSTED,
    retryAfter: { resetAt: NOW + 7 * 24 * 3600_000, fallbackSec: 5, capS: 60 },
    now: NOW,
  });
  assert.equal(s.headers['retry-after'], '60');
});

test('codex shaping: a just-past reset floors at 1s, never 0/negative', () => {
  const s = shapeTerminalThrottle({
    attempts: 2,
    retriesExhaustedHeader: EXHAUSTED,
    retryAfter: { resetAt: NOW - 500, fallbackSec: 5, capS: 60 },
    now: NOW,
  });
  assert.equal(s.headers['retry-after'], '1');
});

test('claude shaping: SDK-loop suppression, no retry-after', () => {
  const s = shapeTerminalThrottle({
    attempts: 4,
    retriesExhaustedHeader: EXHAUSTED,
    suppressClientRetry: true,
    now: NOW,
  });
  assert.deepEqual(s.headers, { [EXHAUSTED]: '4', 'x-should-retry': 'false' });
  assert.equal(s.retryAfterSec, null);
});
