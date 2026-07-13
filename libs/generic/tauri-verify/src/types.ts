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
export type VerifyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string; evidence?: Record<string, unknown> };

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
  route: RouteInfo;
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
  /** Stable destination used by navigateToScreen. */
  href: string;
  route: {
    pathname: string | RegExp;
    query?: Record<string, string | RegExp>;
  };
  requiredElements?: string[];
}

/**
 * Configuration for verification environment.
 */
export interface VerifyConfig {
  /** Preferred target: the exact Tauri process to drive. */
  tauriPID?: number;
  /** Explicit bridge target alternative; both port and token are required. */
  bridgePort?: number;
  bridgeToken?: string;
  windowLabel?: string;
  timeout?: number; // milliseconds
  /** Optional override; defaults to the origin the target webview is actually using. */
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
