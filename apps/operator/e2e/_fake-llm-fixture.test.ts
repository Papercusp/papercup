import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedFakeLlmHarness } from './_fake-llm-fixture';

afterEach(() => vi.unstubAllEnvs());

describe('isolated chat fixture write boundary', () => {
  it.each([
    ['papercusp-workspace', 'postgres://localhost:23456/fixture'],
    ['verify-tauri-isolated-test', 'postgres://localhost:5432/papercusp'],
    ['verify-tauri-isolated-test', 'postgres://remote.example:23456/fixture'],
    ['verify-tauri-isolated-test', 'postgres://localhost/fixture'],
  ])('refuses workspace %s and database %s before starting a fixture writer', async (workspace, database) => {
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '1');
    // A nonexistent source would produce a child-loader error if the guard
    // let the shared/remote database through.
    vi.stubEnv('OPERATOR_SOURCE_ROOT', '/nonexistent-chat-fixture-root');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', workspace);
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', database);
    await expect(seedFakeLlmHarness()).rejects.toThrow(/Missing isolated chat fixture context|Refusing shared chat fixture database/);
  });

  it('does not seed an existing workspace outside the maintained isolated rig', async () => {
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgres://remote.example:5432/live');
    expect(await seedFakeLlmHarness()).toBe('main');
  });
});
