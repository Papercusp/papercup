/**
 * Example: Using @papercusp/tauri-verify in tests
 *
 * This file demonstrates how agents and tests use the Tauri verification surface
 * to assert on app state, route, and scope.
 */

import { createVerifier, SCREENS, type VerifyResult, type AppReady } from '../src/index.js';

/**
 * Example 1: Basic app readiness check
 * Verify the app is ready for testing before running any UI interactions.
 */
async function exampleAppReady() {
  const verify = createVerifier({
    bridgePort: 42391, // tauri-agent-tools default
    apiBaseUrl: 'http://127.0.0.1:3270',
  });

  console.log('Checking if app is ready...');
  const result = await verify.appReady();

  if (result.ok) {
    console.log('✓ App is ready:', result.value);
    console.log('  - Bridge connected:', result.value.bridgeConnected);
    console.log('  - Webview loaded:', result.value.webviewLoaded);
    console.log('  - API healthy:', result.value.apiHealthy);
    console.log('  - Router ready:', result.value.routerReady);
  } else {
    console.error('✗ App not ready:', result.error);
  }
}

/**
 * Example 2: Route assertions
 * Verify we're on the correct page.
 */
async function exampleRouteAssertion() {
  const verify = createVerifier();

  console.log('\nChecking current route...');

  // Exact route match
  const exactRoute = await verify.route('/adv');
  console.log('Exact match "/adv":', exactRoute.ok ? 'passed' : 'failed');

  // Pattern match
  const patternRoute = await verify.route(/^\/adv/);
  if (patternRoute.ok) {
    console.log('✓ On advanced surface');
    console.log(`  - Current URL: ${patternRoute.value.href}`);
    console.log(`  - Pathname: ${patternRoute.value.pathname}`);
  } else {
    console.error('✗ Not on advanced surface:', patternRoute.error);
  }
}

/**
 * Example 3: Scope assertions
 * Verify we're in the correct harness and workspace.
 */
async function exampleScopeAssertion() {
  const verify = createVerifier();

  console.log('\nVerifying scope...');
  const scope = await verify.scope({
    harnessSlug: 'my-test-harness',
    workspaceId: 'workspace-123',
  });

  if (scope.ok) {
    console.log('✓ Scope verification passed');
    console.log(`  - Harness: ${scope.value.harnessSlug}`);
    console.log(`  - Workspace: ${scope.value.workspaceId}`);
    console.log(`  - User: ${scope.value.userId}`);
    console.log(`  - Role: ${scope.value.role}`);
  } else {
    console.error('✗ Scope mismatch:', scope.error);
  }
}

/**
 * Example 4: Semantic screen navigation
 * Use named screens instead of raw URLs.
 */
async function exampleSemanticScreens() {
  const verify = createVerifier();

  console.log('\nWorking with semantic screens...');

  // Get all available screens
  console.log('Available screens:');
  const screens = Object.values(SCREENS);
  screens.forEach((screen) => {
    console.log(`  - ${screen.name} (${screen.id})`);
  });

  // Navigate to a semantic screen
  const harnesHomeResult = await verify.navigateToScreen('harness-home');
  if (harnesHomeResult.ok) {
    console.log(`\n✓ On screen: ${harnesHomeResult.value.name}`);
    console.log(`  - Route pattern: ${harnesHomeResult.value.route}`);
    console.log(`  - Required elements: ${harnesHomeResult.value.requiredElements?.join(', ')}`);
  } else {
    console.error('✗ Could not navigate to screen:', harnesHomeResult.error);
  }

  // Detect current screen
  const currentScreen = await verify.currentScreen();
  if (currentScreen.ok) {
    console.log(`\n✓ Currently on: ${currentScreen.value.name}`);
  } else {
    console.error('✗ Could not determine current screen:', currentScreen.error);
  }
}

/**
 * Example 5: Test helper function
 * Composable verification for common test patterns.
 */
async function exampleTestHelper() {
  // A reusable test helper that verifies the app is ready and on the right screen
  async function verifyAppStateBeforeTest(
    expectedScreenId: string,
    expectedScope?: Partial<{ harnessSlug: string; workspaceId: string }>,
  ): Promise<boolean> {
    const verify = createVerifier();

    // 1. Check app readiness
    const appReady = await verify.appReady();
    if (!appReady.ok) {
      console.error('App not ready:', appReady.error);
      return false;
    }

    // 2. Check semantic screen
    const screen = await verify.navigateToScreen(expectedScreenId);
    if (!screen.ok) {
      console.error(`Not on expected screen "${expectedScreenId}":`, screen.error);
      return false;
    }

    // 3. Optionally check scope
    if (expectedScope) {
      const scope = await verify.scope(expectedScope);
      if (!scope.ok) {
        console.error('Scope mismatch:', scope.error);
        return false;
      }
    }

    return true;
  }

  console.log('\nRunning test with verification helper...');
  const ready = await verifyAppStateBeforeTest('advanced', {
    harnessSlug: 'test-harness',
  });

  if (ready) {
    console.log('✓ App state verified - safe to run test');
  } else {
    console.log('✗ App state verification failed - test would be unreliable');
  }
}

/**
 * Example 6: Error handling patterns
 * How to safely handle verification results.
 */
async function exampleErrorHandling() {
  const verify = createVerifier();

  console.log('\nError handling example...');

  // Pattern 1: Immediate throw on error
  try {
    const result = await verify.appReady();
    if (!result.ok) throw new Error(result.error);
    console.log('✓ App ready');
  } catch (err) {
    console.error('✗ App not ready:', err instanceof Error ? err.message : String(err));
  }

  // Pattern 2: Conditional handling
  const routeResult = await verify.route(/^\/adv/);
  if (routeResult.ok) {
    console.log('✓ On correct route');
    // Use the route info
    const { pathname } = routeResult.value;
    console.log(`  Processing: ${pathname}`);
  } else {
    console.warn('⚠ Route mismatch (might be navigating):', routeResult.error);
    // Could retry or skip this test
  }

  // Pattern 3: Type-safe result handling
  const scopeResult = await verify.scope({ harnessSlug: 'test' });
  // TypeScript knows exactly which fields are available
  if (scopeResult.ok) {
    const { value } = scopeResult;
    console.log(`Harness: ${value.harnessSlug}`);
  } else {
    const { error } = scopeResult;
    console.error('Scope error:', error);
  }
}

/**
 * Run all examples (note: requires running Tauri dev shell)
 */
async function runAllExamples() {
  console.log('=== Tauri Verification Surface Examples ===\n');

  try {
    await exampleAppReady();
    await exampleRouteAssertion();
    await exampleScopeAssertion();
    await exampleSemanticScreens();
    await exampleTestHelper();
    await exampleErrorHandling();

    console.log('\n=== Examples Complete ===');
  } catch (err) {
    console.error('Example error:', err);
    process.exit(1);
  }
}

// Export for testing
export { exampleAppReady, exampleRouteAssertion, exampleScopeAssertion, exampleSemanticScreens, exampleTestHelper, exampleErrorHandling };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples();
}
