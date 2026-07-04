/**
 * tool-guidance-budget.test.ts — per-tool prompt-weight budget
 * (token-usage-reduction-audit-2026-06-09 P-011).
 *
 * The budget logic + constants live in ./tool-guidance-budget.shared.ts so
 * this standalone test AND tools-md-sync.test.ts (the CLAUDE.md-mandated
 * "Adding a tool" quick-check) assert the SAME ratchet from one source of
 * truth — see EI-7284 for why the quick-check must also catch a budget breach.
 */
import { describeToolGuidanceBudget } from './tool-guidance-budget.shared';

describeToolGuidanceBudget();
