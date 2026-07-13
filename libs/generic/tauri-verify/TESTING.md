# Testing @papercusp/tauri-verify

## Test Strategy

This package contains two categories of tests:

### 1. Unit Tests (Vitest)

**Location:** `src/*.test.ts`

**Framework:** Vitest

**What they test:**
- Screen definitions and semantic identifiers
- Type safety and interface contracts
- Configuration handling
- Result type discrimination

**Run:** `npm run test` (from package root) or `npm run test:file -- libs/generic/tauri-verify/src/index.test.ts` (from monorepo root)

**Scope:** Unit tests verify the library's contract and type definitions. They do NOT require a running Tauri shell or bridge.

### 2. Integration Tests (Playwright)

**Location:** (To be added) `apps/operator/e2e/tauri-verify-integration.spec.ts`

**Framework:** Playwright

**What they test:**
- Real Tauri bridge connectivity (tauri-agent-tools)
- App readiness assertions against a running Tauri dev shell
- Route assertions with actual navigation
- Scope assertions with real session data

**Prerequisites:**
- Running Tauri dev shell: `cd papercusp-desktop && npm run dev`
- Bridge accessible at default port (42391) or configured port

**Run:**
```bash
# From monorepo root
npm run test:file -- apps/operator/e2e/tauri-verify-integration.spec.ts

# Or with Playwright CLI
npx playwright test apps/operator/e2e/tauri-verify-integration.spec.ts
```

## Current Test Coverage

### Unit Tests (11 tests)

✓ Verifier creation with defaults  
✓ Verifier creation with custom config  
✓ Verifier creation with partial config merge  
✓ Semantic screens are defined  
✓ Finding screen by ID  
✓ Undefined screen returns undefined  
✓ Screen route patterns work correctly  
✓ Screens have required elements  
✓ Verifier interface completeness  
✓ Success result type  
✓ Error result type  

### Integration Tests (Pending)

The following integration tests should be implemented:

- [ ] Bridge connectivity to running Tauri shell
- [ ] App readiness check with real webview
- [ ] Route matching with actual navigation
- [ ] Scope assertion with real session
- [ ] Error handling for disconnected bridge
- [ ] Timeout handling for slow responses

## Running Tests

### Local Development

```bash
# Run unit tests only
cd libs/generic/tauri-verify
npm run test

# Run specific test file
npm run test -- src/index.test.ts --run

# Watch mode
npm run test -- --watch
```

### In CI

The test file is automatically discovered by the monorepo's test registry and runs as part of:

```bash
npm run test:affected        # unit tests only
npm run test:affected:integration  # includes integration tests
```

## Test Additions

When adding new functionality to @papercusp/tauri-verify:

1. **Add unit tests** to `src/*.test.ts` for:
   - Type contracts
   - Configuration handling
   - Screen definitions
   - Result type correctness

2. **Add integration tests** to `apps/operator/e2e/tauri-verify-integration.spec.ts` for:
   - Actual Tauri bridge calls
   - Real webview interactions
   - End-to-end assertions

3. **Update this file** with new test descriptions

## Known Limitations

- Unit tests do not require a running Tauri shell (by design)
- Integration tests require a dev shell running
- Bridge timeout of 5s is configurable but tests use default
- API health check is optional (non-blocking on test failure)

## References

- `/internal/docs/testing/` — Full testing strategy
- `/internal/docs/testing/agent-e2e.md` — Tauri E2E playbook
- `tauri-agent-tools` repository — Bridge implementation
