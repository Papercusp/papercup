/**
 * tool-weight-selfcheck — EI-10966: warn, at catalog-registration time, when any
 * tool is over the prompt-weight budget. Imported LAST in the agent-tools barrel
 * so every tool has already registered; the live operator (a hot-reloading dev
 * server) re-runs it on every edit to a tool file, so an over-budget guidance
 * edit surfaces in the operator's own logs the moment it is saved — NOT hours
 * later when it reds the fleet-blocking green gate.
 *
 * Gated `!process.env.VITEST`: the dedicated gate test (tool-guidance-budget.test.ts)
 * asserts this deliberately, and `vitest-fail-on-console` would otherwise turn a
 * warn here into a failure of every UNRELATED suite that imports the catalog —
 * re-creating the very "one edit reds everyone" blast radius this fix exists to
 * shrink. In the operator process (no vitest) it is a plain, visible log line.
 *
 * Fail-soft: a bug in the check must never block operator boot (mirrors every
 * other side-effect block in index.ts).
 */
import { budgetViolations, formatViolations } from './tool-guidance-budget';

export function runToolWeightSelfCheck(): void {
  if (process.env.VITEST) return;
  const violations = budgetViolations();
  if (violations.length === 0) return;
  const hardCaps = violations.filter((v) => v.hardCap).length;
  // eslint-disable-next-line no-console -- intentional operator-log signal; suppressed under vitest above
  console.warn(
    `[tool-weight] ${violations.length} tool(s) over the prompt-weight budget` +
      (hardCaps > 0 ? ` (${hardCaps} over the HARD CAP — these RED the green gate)` : '') +
      ` — trim before the next green checkpoint or deploys freeze fleet-wide (EI-10966):\n` +
      formatViolations(violations),
  );
}

try {
  runToolWeightSelfCheck();
} catch {
  /* never block boot */
}
