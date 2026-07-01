/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer and writes it to two PG tables:
 *   1. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   2. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
 *
 * Was previously also duplicated to `<papercuspRoot>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes — that file is gone;
 * routes now read the bearer from token_index via apps/operator/lib/system-principal.ts.
 *
 * Idempotent per (workspace, name): re-running with the same name skips
 * if a row already exists (use `force: true` to rotate the bearer).
 */
export interface ProvisionSystemPrincipalArgs {
    workspaceId: string;
    name: string;
    capabilities: string[];
    papercuspRoot: string;
    force?: boolean;
}
export interface ProvisionResult {
    workspaceId: string;
    name: string;
    /** The freshly-minted bearer — present ONLY when a bearer was created (initial
     *  provision) or rotated (`force`). ABSENT on a capabilities-only RECONCILE, which
     *  leaves the existing bearer untouched (there is no new bearer to return). */
    bearer?: string;
    /** Display label kept for log/UI surfaces; refers to where the bearer
     *  USED TO be written. The actual source of truth is now PG (token_index). */
    configPath: string;
    rotated: boolean;
    /** True when an ALREADY-PROVISIONED principal's capabilities were brought up to the
     *  code-defined set IN PLACE (additive, NO bearer rotation). EI-2048. */
    reconciled?: boolean;
}
/**
 * The ADDITIVE capability-reconcile decision (EI-2048), pure + exported for tests.
 * Returns the caps in `code` that `stored` lacks (`missing`) and the union to persist
 * (`merged`). NEVER removes a stored cap not in `code` — shrinking a principal's caps is
 * an attended `force` reprovision, not an automatic forceless-deploy side effect. When
 * `missing` is empty the live row is already current and the caller writes nothing.
 */
export declare function reconcileCapabilities(stored: readonly string[], code: readonly string[]): {
    missing: string[];
    merged: string[];
};
export declare function provisionSystemPrincipal(args: ProvisionSystemPrincipalArgs): Promise<ProvisionResult | null>;
export interface StartPiSessionArgs {
    workspaceId: string;
    sessionId: string;
    capabilities: string[];
}
export interface PiSessionResult {
    bearer: string;
    sessionId: string;
}
export declare function startPiSession(args: StartPiSessionArgs): Promise<PiSessionResult>;
export declare function endPiSession(workspaceId: string, sessionId: string): Promise<void>;
