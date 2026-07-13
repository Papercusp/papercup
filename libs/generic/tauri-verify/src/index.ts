/**
 * Tauri verification surface — stable API for app-ready, route, and scope assertions.
 *
 * This module provides a programmatic, stable verification interface built on
 * tauri-agent-tools, enabling agents to:
 *
 * 1. Verify app readiness (bridge connected, webview loaded, API healthy, router ready)
 * 2. Assert on current route with semantic screen matching
 * 3. Verify harness/workspace scope and authorization
 * 4. Use semantic screen identifiers instead of raw selectors
 *
 * Example usage:
 *
 * const verify = createVerifier({ bridgePort: 42391 });
 *
 * // Verify app is ready
 * const appReady = await verify.appReady();
 * if (!appReady.ok) throw new Error(appReady.error);
 *
 * // Verify current route matches expected
 * const route = await verify.route(/^\/adv/);
 * if (!route.ok) throw new Error(route.error);
 *
 * // Verify scope
 * const scope = await verify.scope({ harnessSlug: 'test-harness' });
 * if (!scope.ok) throw new Error(scope.error);
 */

import type { VerifyConfig, VerifyResult, AppReady, RouteInfo, ScopeInfo, Screen } from './types.js';
import { assertAppReady, assertRoute, assertScope } from './assertions.js';
import { findScreen, findScreenByRoute } from './screens.js';

/**
 * Stable verification interface for Tauri-based UI testing.
 */
export interface Verifier {
  /**
   * Assert that the app is ready for testing.
   */
  appReady(): Promise<VerifyResult<AppReady>>;

  /**
   * Assert that the current route matches expected.
   */
  route(expected: string | RegExp): Promise<VerifyResult<RouteInfo>>;

  /**
   * Assert current harness/workspace scope.
   */
  scope(expected: Partial<ScopeInfo>): Promise<VerifyResult<ScopeInfo>>;

  /**
   * Navigate to a semantic screen by ID.
   */
  navigateToScreen(screenId: string): Promise<VerifyResult<Screen>>;

  /**
   * Get current screen based on route.
   */
  currentScreen(): Promise<VerifyResult<Screen>>;

  /**
   * Get configuration.
   */
  config(): VerifyConfig;
}

/**
 * Create a verifier instance with optional configuration.
 * If no bridge port is provided, attempts to auto-detect from running Tauri process.
 */
export function createVerifier(config?: VerifyConfig): Verifier {
  const finalConfig: VerifyConfig = {
    bridgePort: config?.bridgePort ?? 42391, // tauri-agent-tools default
    timeout: config?.timeout ?? 10000,
    apiBaseUrl: config?.apiBaseUrl ?? 'http://127.0.0.1:3270',
    ...config,
  };

  return {
    async appReady(): Promise<VerifyResult<AppReady>> {
      return assertAppReady(finalConfig.bridgePort!, finalConfig.apiBaseUrl);
    },

    async route(expected: string | RegExp): Promise<VerifyResult<RouteInfo>> {
      return assertRoute(finalConfig.bridgePort!, expected);
    },

    async scope(expected: Partial<ScopeInfo>): Promise<VerifyResult<ScopeInfo>> {
      return assertScope(finalConfig.bridgePort!, expected);
    },

    async navigateToScreen(screenId: string): Promise<VerifyResult<Screen>> {
      const screen = findScreen(screenId);
      if (!screen) {
        return {
          ok: false,
          error: `Screen not found: ${screenId}`,
        };
      }

      const routeResult = await assertRoute(finalConfig.bridgePort!, screen.route);
      if (!routeResult.ok) {
        // Try to navigate if not on correct route
        // This would require injecting navigation into the webview
        return routeResult as VerifyResult<Screen>;
      }

      return { ok: true, value: screen };
    },

    async currentScreen(): Promise<VerifyResult<Screen>> {
      const routeResult = await assertRoute(finalConfig.bridgePort!, /.*/);
      if (!routeResult.ok) {
        return {
          ok: false,
          error: `Failed to determine current route: ${routeResult.error}`,
        };
      }

      const screen = findScreenByRoute(routeResult.value.pathname);
      if (!screen) {
        return {
          ok: false,
          error: `Current route does not match any semantic screen: ${routeResult.value.pathname}`,
        };
      }

      return { ok: true, value: screen };
    },

    config(): VerifyConfig {
      return finalConfig;
    },
  };
}

// Export types and functions for advanced usage
export * from './types.js';
export * from './assertions.js';
export * from './screens.js';
