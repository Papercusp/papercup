/** Stable, target-explicit assertions over the authenticated Tauri dev bridge. */
import type {
  AppReady,
  AssertionResult,
  BridgeStatus,
  RouteInfo,
  ScopeInfo,
  VerifyConfig,
  VerifyResult,
} from './types.js';
import { bridgeEval, resolveBridge } from './bridge-client.js';

function parseJsonResult<T>(result: unknown, label: string): VerifyResult<T> {
  if (typeof result !== 'string') {
    return { ok: false, code: 'invalid_eval_result', error: `${label} did not return JSON text.` };
  }
  try {
    return { ok: true, value: JSON.parse(result) as T };
  } catch {
    return { ok: false, code: 'invalid_eval_json', error: `Failed to parse ${label}.` };
  }
}

export async function readRoute(config: VerifyConfig): Promise<VerifyResult<RouteInfo>> {
  const result = await bridgeEval<string>(
    config,
    'JSON.stringify({ href: location.href, pathname: location.pathname, search: location.search, hash: location.hash })',
  );
  return result.ok ? parseJsonResult<RouteInfo>(result.value, 'route info') : result;
}

export async function assertBridgeConnected(config: VerifyConfig): Promise<VerifyResult<BridgeStatus>> {
  const bridge = await resolveBridge(config);
  if (!bridge.ok) return bridge;
  const result = await bridgeEval<string>(
    config,
    'JSON.stringify({ href: location.href, title: document.title, readyState: document.readyState })',
  );
  if (!result.ok) return result;
  const page = parseJsonResult<{ href: string; title: string; readyState: string }>(result.value, 'bridge page state');
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      bridgeAlive: true,
      bridgeVersion: 'authenticated-eval',
      tauriPID: bridge.value.pid ?? 0,
      port: bridge.value.port,
      webviewURL: page.value.href,
      pageTitle: page.value.title,
    },
  };
}

export async function assertAppReady(config: VerifyConfig): Promise<VerifyResult<AppReady>> {
  const bridge = await assertBridgeConnected(config);
  if (!bridge.ok) return { ...bridge, error: `Bridge not ready: ${bridge.error}` };

  const stateResult = await bridgeEval<string>(
    config,
    `JSON.stringify({
      readyState: document.readyState,
      rootMounted: (document.querySelector('#root')?.childElementCount ?? 0) > 0,
      href: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      origin: location.origin
    })`,
  );
  if (!stateResult.ok) return stateResult;
  const state = parseJsonResult<{
    readyState: string;
    rootMounted: boolean;
    href: string;
    pathname: string;
    search: string;
    hash: string;
    origin: string;
  }>(stateResult.value, 'app readiness state');
  if (!state.ok) return state;

  const webviewLoaded = ['interactive', 'complete'].includes(state.value.readyState);
  const routerReady = state.value.rootMounted && state.value.pathname.startsWith('/');
  if (!webviewLoaded || !routerReady) {
    return {
      ok: false,
      code: 'webview_not_ready',
      error: `Webview not ready: readyState=${state.value.readyState}, rootMounted=${state.value.rootMounted}`,
      evidence: state.value,
    };
  }

  const apiBaseUrl = config.apiBaseUrl ?? state.value.origin;
  try {
    const response = await fetch(new URL('/api/health', apiBaseUrl), {
      signal: AbortSignal.timeout(config.timeout ?? 10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        code: 'api_unhealthy',
        error: `Target webview API is unhealthy: ${response.status} ${response.statusText}`,
        evidence: { apiBaseUrl, webviewURL: state.value.href },
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'api_unreachable',
      error: `Target webview API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { apiBaseUrl, webviewURL: state.value.href },
    };
  }

  return {
    ok: true,
    value: {
      bridgeConnected: true,
      webviewLoaded: true,
      apiHealthy: true,
      routerReady: true,
      route: {
        href: state.value.href,
        pathname: state.value.pathname,
        search: state.value.search,
        hash: state.value.hash,
      },
    },
  };
}

export function routeMatches(route: RouteInfo, expected: string | RegExp): boolean {
  if (typeof expected === 'string') return route.pathname === expected;
  expected.lastIndex = 0;
  return expected.test(route.pathname);
}

export async function assertRoute(
  config: VerifyConfig,
  expectedRoute: string | RegExp,
): Promise<VerifyResult<RouteInfo>> {
  const route = await readRoute(config);
  if (!route.ok) return route;
  if (!routeMatches(route.value, expectedRoute)) {
    return {
      ok: false,
      code: 'route_mismatch',
      error: `Route mismatch: expected ${String(expectedRoute)}, got ${route.value.pathname}${route.value.search}`,
      evidence: route.value,
    };
  }
  return route;
}

export async function assertScope(
  config: VerifyConfig,
  expectedScope: Partial<ScopeInfo>,
): Promise<VerifyResult<ScopeInfo>> {
  const result = await bridgeEval<string>(
    config,
    `(() => {
      const url = new URL(location.href);
      const pathHarness = location.pathname.match(/^\\/harness\\/([^/]+)/)?.[1];
      return JSON.stringify({
        harnessSlug: url.searchParams.get('slug') || url.searchParams.get('harness') || pathHarness || undefined,
        workspaceId: window.__PAPERCUSP_WS__ || url.searchParams.get('ws') || 'default'
      });
    })()`,
  );
  if (!result.ok) return result;
  const scope = parseJsonResult<ScopeInfo>(result.value, 'scope info');
  if (!scope.ok) return scope;

  for (const [key, expectedValue] of Object.entries(expectedScope)) {
    if (expectedValue !== undefined && scope.value[key as keyof ScopeInfo] !== expectedValue) {
      return {
        ok: false,
        code: 'scope_mismatch',
        error: `Scope mismatch: expected ${key}=${String(expectedValue)}, got ${String(scope.value[key as keyof ScopeInfo])}`,
        evidence: scope.value,
      };
    }
  }
  return scope;
}

export function formatAssertionResult(result: AssertionResult): string {
  const status = result.passed ? '✓' : '✗';
  return `${status} ${result.message}${result.details ? ` | ${JSON.stringify(result.details)}` : ''}`;
}
