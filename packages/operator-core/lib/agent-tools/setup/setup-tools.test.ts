/**
 * setup-tools.test.ts — the setup:* onboarding-tutor verbs
 * (agent-first-onboarding-2026-07-03 P-004), PG + credentials mocked.
 *
 * Pins: the wizard-state merge semantics (consent decided both ways, channel
 * choice, graduation idempotence + force), the save_key mask (raw secret
 * never echoed), and that setup:status is a pure projection of
 * collectSetupStatus (the same read the GUI wizard uses).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/setup/setup-tools.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    read: vi.fn(async (k: string) => store.get(k) ?? null),
    write: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    creds: { current: {} as Record<string, string | undefined> },
    collect: vi.fn(async () => ({
      statuses: { git: 'ok', telemetry: 'needs-attention' },
      agentRuntime: { claude: true, codex: false, omp: false, meridian: false },
    })),
  };
});
vi.mock('../../operator-state-pg', () => ({
  readOperatorState: h.read,
  writeOperatorState: h.write,
}));
vi.mock('../../setup-wizard-install-id', () => ({ ensureInstallId: vi.fn() }));
vi.mock('../../credentials', () => ({
  readCredentials: vi.fn(async () => ({ ...h.creds.current })),
  writeCredentials: vi.fn(async (c: Record<string, string | undefined>) => {
    h.creds.current = c;
    return c;
  }),
  maskSecret: (v?: string | null) => (v ? `${v.slice(0, 3)}…` : null),
}));
vi.mock('../../endpoint-route/routes/desktop/setup-status', () => ({
  collectSetupStatus: h.collect,
}));

const setTelemetry = (await import('./set_telemetry')).default;
const setChannel = (await import('./set_update_channel')).default;
const complete = (await import('./complete')).default;
const saveKey = (await import('./save_key')).default;
const status = (await import('./status')).default;
const setProgress = (await import('./set_tutorial_progress')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const call = (
  tool: { handler: (a: never, c: never) => unknown },
  args: Record<string, unknown> = {},
) => tool.handler(args as never, {} as never) as Promise<Out>;

const wizard = () => h.store.get('setup_wizard_state') as Record<string, unknown> | undefined;

beforeEach(() => {
  h.store.clear();
  h.creds.current = {};
});

describe('setup:set_telemetry', () => {
  it('records consent BOTH ways — true and false are each a decision', async () => {
    expect(body(await call(setTelemetry, { enabled: true }))).toEqual({ telemetry_enabled: true });
    expect(wizard()?.telemetry_enabled).toBe(true);
    expect(body(await call(setTelemetry, { enabled: false }))).toEqual({ telemetry_enabled: false });
    expect(wizard()?.telemetry_enabled).toBe(false);
  });
});

describe('setup:set_update_channel', () => {
  it('sets the channel and PRESERVES other wizard state (merge, not replace)', async () => {
    await call(setTelemetry, { enabled: true });
    const b = body(await call(setChannel, { channel: 'beta' }));
    expect(b).toEqual({ update_channel: 'beta' });
    expect(wizard()).toMatchObject({ update_channel: 'beta', telemetry_enabled: true });
  });
});

describe('setup:complete (graduation)', () => {
  it('stamps finished_at once and is idempotent after that', async () => {
    const first = body(await call(complete));
    expect(first.alreadyFinished).toBe(false);
    expect(typeof first.finished_at).toBe('string');

    const second = body(await call(complete));
    expect(second).toEqual({ finished_at: first.finished_at, alreadyFinished: true });
  });

  it('force re-stamps', async () => {
    await call(complete);
    const forced = body(await call(complete, { force: true }));
    expect(forced.alreadyFinished).toBe(false);
    expect(typeof forced.finished_at).toBe('string');
  });
});

describe('setup:save_key', () => {
  it('stores the trimmed secret and returns it MASKED, never raw', async () => {
    const raw = '  sk-test-123456789  ';
    const b = body(await call(saveKey, { key: 'openai_api_key', value: raw }));
    expect(h.creds.current.openai_api_key).toBe('sk-test-123456789');
    expect(b).toEqual({ ok: true, key: 'openai_api_key', masked: 'sk-…' });
    expect(JSON.stringify(b)).not.toContain('123456789');
  });

  it('merges instead of clobbering other keys', async () => {
    h.creds.current = { github_pat: 'ghp_existing' };
    await call(saveKey, { key: 'anthropic_api_key', value: 'sk-ant-abcdef' });
    expect(h.creds.current).toMatchObject({
      github_pat: 'ghp_existing',
      anthropic_api_key: 'sk-ant-abcdef',
    });
  });
});

describe('setup:set_tutorial_progress', () => {
  it('merges position + completed list, preserving other wizard state', async () => {
    await call(setTelemetry, { enabled: true });
    let b = body(await call(setProgress, { last_section_id: 'ch1-01-server-gui-tutorial' }));
    expect(b.tutorial_progress).toMatchObject({ last_section_id: 'ch1-01-server-gui-tutorial' });

    b = body(
      await call(setProgress, {
        last_section_id: 'ch2-01-plans',
        completed_ids: ['ch1-01-server-gui-tutorial', 'ch1-02-pots-harnesses-blueprints'],
      }),
    );
    expect(b.tutorial_progress).toMatchObject({
      last_section_id: 'ch2-01-plans',
      completed_ids: ['ch1-01-server-gui-tutorial', 'ch1-02-pots-harnesses-blueprints'],
    });
    expect(typeof b.tutorial_progress.updated_at).toBe('string');
    expect(wizard()).toMatchObject({ telemetry_enabled: true }); // merge, not replace
  });

  it('clear erases progress (restart from the top)', async () => {
    await call(setProgress, { last_section_id: 'ch2-01-plans' });
    const b = body(await call(setProgress, { clear: true }));
    expect(b.tutorial_progress).toBeNull();
    expect(wizard()?.tutorial_progress).toBeUndefined();
  });
});

describe('setup:status', () => {
  it('is a pure projection of collectSetupStatus (the wizard-shared read)', async () => {
    const b = body(await call(status));
    expect(h.collect).toHaveBeenCalled();
    expect(b).toEqual({
      statuses: { git: 'ok', telemetry: 'needs-attention' },
      agentRuntime: { claude: true, codex: false, omp: false, meridian: false },
    });
  });
});
