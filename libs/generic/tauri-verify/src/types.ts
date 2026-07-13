/**
 * Core types for Tauri verification surface.
 *
 * Provides stable types for:
 * - App readiness verification
 * - Route assertions
 * - Scope (harness/workspace) assertions
 * - Semantic screen identification
 */

/**
 * Result of a verification operation.
 * Either a successful value or an error message.
 */
export type VerifyResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Bridge connection status.
 */
export interface BridgeStatus {
  bridgeAlive: boolean;
  bridgeVersion: string;
  tauriPID: number;
  port: number;
  webviewURL: string;
  pageTitle: string;
}

/**
 * App readiness state.
 */
export interface AppReady {
  bridgeConnected: boolean;
  webviewLoaded: boolean;
  apiHealthy: boolean;
  routerReady: boolean;
}

/**
 * Current route information.
 */
export interface RouteInfo {
  href: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Harness/workspace scope information.
 */
export interface ScopeInfo {
  harnessSlug?: string;
  workspaceId?: string;
  userId?: string;
  role?: string;
}

/**
 * Semantic screen identifier.
 * Provides meaningful names for testable UI surfaces.
 */
export interface Screen {
  id: string;
  name: string;
  route: string | RegExp;
  requiredElements?: string[]; // CSS selectors that must be present
}

/**
 * Configuration for verification environment.
 */
export interface VerifyConfig {
  bridgePort?: number;
  tauriPID?: number;
  timeout?: number; // milliseconds
  apiBaseUrl?: string;
}

/**
 * Assertion result with metadata.
 */
export interface AssertionResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
}
