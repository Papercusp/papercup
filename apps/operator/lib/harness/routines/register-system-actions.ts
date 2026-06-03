/**
 * Side-effect imports that populate the system-action registry
 * (`system-actions.ts`). The routines engine imports this module once, so every
 * `system:<action>` handler is registered before the first tick dispatches.
 *
 * Add a new system action by importing its module here (the module body calls
 * `registerSystemAction(...)`).
 *
 * Registered handlers:
 *   - `system:git-sync` — git-sync-auto-commit P-005/P-009/P-010/P-012.
 */
import '@/lib/harness/git-sync/git-sync-action';
