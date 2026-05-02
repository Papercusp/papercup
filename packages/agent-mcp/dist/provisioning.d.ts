/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer, writes it to the three required places per
 * spec/system-and-pi-principals:
 *   1. <papercuspRoot>/system/<name>/config.json (mode 0600)
 *   2. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   3. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
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
    bearer: string;
    configPath: string;
    rotated: boolean;
}
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
