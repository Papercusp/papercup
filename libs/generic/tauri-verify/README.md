# @papercusp/tauri-verify

Stable Tauri verification surface for programmatic UI testing of the Papercusp operator.

Built on `tauri-agent-tools` bridge, this library provides a stable, composable API for:

- **App readiness assertions** — verify the Tauri bridge is connected, webview is loaded, API is healthy, and router is available
- **Route assertions** — verify current route and navigate to expected pages
- **Scope assertions** — verify harness scope, workspace ID, user role
- **Semantic screen identifiers** — use meaningful names instead of raw DOM selectors

## Installation

```bash
npm install @papercusp/tauri-verify
```

## Quick Start

```typescript
import { createVerifier, SCREENS } from '@papercusp/tauri-verify';

// Create a verifier instance
const verify = createVerifier({ bridgePort: 42391 });

// Verify app is ready
const appReady = await verify.appReady();
if (!appReady.ok) throw new Error(appReady.error);

// Verify current route
const route = await verify.route(/^\/adv/);
if (!route.ok) throw new Error(route.error);

// Verify scope
const scope = await verify.scope({ harnessSlug: 'my-harness' });
if (!scope.ok) throw new Error(scope.error);

// Get current semantic screen
const screen = await verify.currentScreen();
if (!screen.ok) throw new Error(screen.error);
console.log(`Currently on: ${screen.value.name}`);
```

## Configuration

The `createVerifier` function accepts a `VerifyConfig` object:

```typescript
interface VerifyConfig {
  bridgePort?: number;        // Default: 42391 (tauri-agent-tools default)
  tauriPID?: number;          // Optional: Tauri process ID
  timeout?: number;           // Default: 10000 (milliseconds)
  apiBaseUrl?: string;        // Default: 'http://127.0.0.1:3270'
}
```

## API Reference

### `createVerifier(config?: VerifyConfig): Verifier`

Creates a verifier instance with optional configuration.

### `Verifier` Interface

#### `appReady(): Promise<VerifyResult<AppReady>>`

Verifies that the app is ready for testing by checking:
- Tauri bridge connectivity
- Webview loaded and DOM ready
- API endpoint health
- TanStack Router availability

Returns a result containing:
- `bridgeConnected: boolean`
- `webviewLoaded: boolean`
- `apiHealthy: boolean`
- `routerReady: boolean`

#### `route(expected: string | RegExp): Promise<VerifyResult<RouteInfo>>`

Asserts that the current route matches the expected route.

```typescript
// Exact match
await verify.route('/adv');

// Pattern match
await verify.route(/^\/adv\?.*tab=harnesses/);
```

Returns current route information:
- `href: string`
- `pathname: string`
- `search: string`
- `hash: string`

#### `scope(expected: Partial<ScopeInfo>): Promise<VerifyResult<ScopeInfo>>`

Verifies current harness/workspace scope matches expected.

```typescript
await verify.scope({
  harnessSlug: 'my-harness',
  workspaceId: 'workspace-1',
});
```

Returns scope information:
- `harnessSlug?: string`
- `workspaceId?: string`
- `userId?: string`
- `role?: string`

#### `currentScreen(): Promise<VerifyResult<Screen>>`

Determines the current semantic screen based on the current route.

```typescript
const screen = await verify.currentScreen();
if (screen.ok) {
  console.log(`On ${screen.value.name}`);
  console.log(`Required elements: ${screen.value.requiredElements?.join(', ')}`);
}
```

Returns a `Screen` object with:
- `id: string` — semantic identifier
- `name: string` — human-readable name
- `route: string | RegExp` — route pattern
- `requiredElements?: string[]` — CSS selectors for validation

#### `navigateToScreen(screenId: string): Promise<VerifyResult<Screen>>`

Navigate to a semantic screen by ID.

```typescript
await verify.navigateToScreen('harness-home');
```

#### `config(): VerifyConfig`

Returns the current configuration.

## Semantic Screens

Standard semantic screens are defined in `SCREENS`:

- `ONBOARDING` — Setup wizard (`/setup`)
- `LOGIN` — Login page (`/auth/login`)
- `ADVANCED` — Main operator surface (`/adv`)
- `HARNESS_HOME` — Harness list view (`/adv?tab=harnesses`)
- `HARNESS_DETAIL` — Single harness detail page
- `WORK_ITEMS` — Work items view
- `SETTINGS` — User settings
- `ADMIN` — Admin panel

Import and use them:

```typescript
import { SCREENS } from '@papercusp/tauri-verify';

// Find a screen by ID
const screen = SCREENS.HARNESS_HOME;
console.log(screen.name);  // 'Harness Home'
console.log(screen.route); // /^\/adv\?.*tab=harnesses/
```

## Result Type

All async verifier methods return a `VerifyResult<T>`, which is either:

**Success:**
```typescript
{ ok: true, value: T }
```

**Error:**
```typescript
{ ok: false, error: string }
```

This union type ensures you must handle both cases:

```typescript
const result = await verify.appReady();

if (result.ok) {
  console.log('App is ready:', result.value);
} else {
  console.error('App not ready:', result.error);
}
```

## Usage in Tests

### Playwright Integration

```typescript
import { test, expect } from '@playwright/test';
import { createVerifier } from '@papercusp/tauri-verify';

test('verifies operator loads correctly', async () => {
  const verify = createVerifier();

  // Verify app is ready
  const appReady = await verify.appReady();
  expect(appReady.ok).toBe(true);

  // Verify on correct page
  const route = await verify.route(/^\/adv/);
  expect(route.ok).toBe(true);

  // Verify correct harness scope
  const scope = await verify.scope({ harnessSlug: 'test' });
  expect(scope.ok).toBe(true);
});
```

### Vitest Unit Tests

```typescript
import { describe, it, expect } from 'vitest';
import { createVerifier, SCREENS } from '@papercusp/tauri-verify';

describe('Tauri Verification Surface', () => {
  it('provides stable semantic screens', () => {
    expect(SCREENS.ADVANCED).toBeDefined();
    expect(SCREENS.HARNESS_HOME).toBeDefined();
  });

  it('creates verifier with config', () => {
    const verify = createVerifier({ bridgePort: 5555 });
    expect(verify.config().bridgePort).toBe(5555);
  });
});
```

## Advanced Usage

### Custom Screen Definition

You can extend or create custom screens:

```typescript
import type { Screen } from '@papercusp/tauri-verify';

const customScreen: Screen = {
  id: 'custom-feature',
  name: 'Custom Feature',
  route: /^\/adv\/custom/,
  requiredElements: ['[data-feature="custom"]'],
};
```

### Error Handling with Type Guards

```typescript
const result = await verify.route(/^\/adv/);

if (!result.ok) {
  // TypeScript knows `result.error` exists here
  console.error('Route assertion failed:', result.error);
} else {
  // TypeScript knows `result.value` exists here
  const pathname = result.value.pathname;
}
```

## Testing Without Live Tauri Bridge

For unit tests without a running Tauri shell, all public types and screen definitions are available for import and testing:

```typescript
import { SCREENS, findScreen, getAllScreens } from '@papercusp/tauri-verify';

describe('Screen definitions', () => {
  it('defines expected screens', () => {
    const screens = getAllScreens();
    expect(screens.length).toBeGreaterThan(0);
  });
});
```

## See Also

- `/internal/docs/testing/agent-e2e` — Full Tauri E2E testing playbook
- `tauri-agent-tools` — Underlying bridge tool this library wraps
- `@papercusp/tauri-release-kit` — Tauri build and release orchestration
