import { describe, it, expect, vi } from 'vitest';
import {
  effectiveBackend,
  readAgentConfig,
  parseSurfaceModels,
  parseBackends,
  parseBulkResolverLaunchProfiles,
  parseRoleBackends,
  parseTiers,
  parseTierCeilings,
  parseTerminalEmulator,
  parseInteractiveClient,
  bulkResolverLaunchProfilesProblem,
  agentCmdBootWarning,
  type AgentConfig,
} from './agent-config';
import { BULK_RESOLVER_PROFILE_KINDS } from './agent-config-constants';
import { BULK_RUN_KINDS } from './attention/bulk-run-store';

// Mock the PG-backed operator-state read so readAgentConfig exercises the
// no-row fallback without touching a database.
const { readOperatorStateMock } = vi.hoisted(() => ({ readOperatorStateMock: vi.fn() }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: readOperatorStateMock,
  writeOperatorState: vi.fn(async () => {}),
}));

function cfg(partial: Partial<AgentConfig>): AgentConfig {
  return { backend: 'auto', cmd: '', models: {}, ...partial };
}

describe('readAgentConfig default backend (no stored row)', () => {
  it('defaults an unconfigured workspace to claude-code, NOT omp', async () => {
    // A freshly-created workspace (e.g. generic-test) has no operator_agent_config
    // row. It must inherit claude-code — the repo's canonical backend — so the
    // New-Plan button launches a claude planner, not omp. (Owner bug 2026-06-18.)
    readOperatorStateMock.mockResolvedValueOnce(null);
    const c = await readAgentConfig();
    expect(c.backend).toBe('claude-code');
    expect(c.interactiveClient).toBe('legacy');
    expect(effectiveBackend(c)).toBe('claude-code');
    expect(c.resolverProfiles).toEqual({
      'inbox-resolve': { model: null, effort: null, account: 'default', carry: 'warm' },
      'plan-cleanup': { model: null, effort: null, account: 'default', carry: 'warm' },
    });
  });

  it('an invalid stored backend falls back to the claude-code default', async () => {
    readOperatorStateMock.mockResolvedValueOnce({ backend: 'gemini' });
    expect((await readAgentConfig()).backend).toBe('claude-code');
  });
});

describe('parseInteractiveClient', () => {
  it('accepts the owned PUI preference and otherwise fails closed to legacy', () => {
    expect(parseInteractiveClient('pui')).toBe('pui');
    expect(parseInteractiveClient('legacy')).toBe('legacy');
    expect(parseInteractiveClient('unknown')).toBe('legacy');
    expect(parseInteractiveClient(null)).toBe('legacy');
  });
});

describe('bulk resolver launch profiles', () => {
  it('covers every generalized bulk-run kind', () => {
    expect([...BULK_RESOLVER_PROFILE_KINDS]).toEqual([...BULK_RUN_KINDS]);
  });

  it('normalizes separate Inbox and Plans defaults with canonical launch values', () => {
    expect(
      parseBulkResolverLaunchProfiles({
        'inbox-resolve': { model: ' sonnet ', effort: 'HIGH', account: 'auto', carry: 'cold' },
        'plan-cleanup': { model: 'openrouter/anthropic/claude', effort: null, account: 'pool:2', carry: 'warm' },
      }),
    ).toEqual({
      'inbox-resolve': { model: 'sonnet', effort: 'high', account: 'auto', carry: 'cold' },
      'plan-cleanup': { model: 'openrouter/anthropic/claude', effort: null, account: 'pool:2', carry: 'warm' },
    });
  });

  it('preserves the untouched pane when a partial document is merged', () => {
    const current = parseBulkResolverLaunchProfiles({
      'inbox-resolve': { model: 'sonnet', effort: 'high', account: 'auto', carry: 'warm' },
      'plan-cleanup': { model: 'opus', effort: 'xhigh', account: 'default', carry: 'cold' },
    });
    expect(parseBulkResolverLaunchProfiles({ 'inbox-resolve': { account: 'pool-a' } }, current)).toEqual({
      'inbox-resolve': { model: 'sonnet', effort: 'high', account: 'pool-a', carry: 'warm' },
      'plan-cleanup': { model: 'opus', effort: 'xhigh', account: 'default', carry: 'cold' },
    });
  });

  it('reports strict write problems instead of silently dropping them', () => {
    expect(bulkResolverLaunchProfilesProblem({ nope: {} })).toMatch(/unknown run kind/);
    expect(bulkResolverLaunchProfilesProblem({ 'inbox-resolve': { account: 'has spaces' } })).toMatch(/account/);
    expect(bulkResolverLaunchProfilesProblem({ 'inbox-resolve': { effort: 'high' } })).toMatch(
      /requires an explicit model/,
    );
    expect(bulkResolverLaunchProfilesProblem({ 'plan-cleanup': { carry: 'tepid' } })).toMatch(/warm or cold/);
  });
});

describe('parseTerminalEmulator', () => {
  it('keeps a command-free terminal binary name', () => {
    expect(parseTerminalEmulator(' gnome-terminal ')).toBe('gnome-terminal');
  });

  it('drops paths and shell commands so the preference cannot become execution', () => {
    expect(parseTerminalEmulator('/usr/bin/gnome-terminal')).toBe('');
    expect(parseTerminalEmulator('gnome-terminal; touch /tmp/nope')).toBe('');
    expect(parseTerminalEmulator(null)).toBe('');
  });
});

describe('effectiveBackend', () => {
  it('returns an explicit backend verbatim (no inference)', () => {
    expect(effectiveBackend(cfg({ backend: 'claude-code', cmd: 'omp -p' }))).toBe('claude-code');
    expect(effectiveBackend(cfg({ backend: 'omp', cmd: 'claude -p' }))).toBe('omp');
  });

  it("infers claude-code from a `claude` binary when backend is 'auto'", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'claude -p' }))).toBe('claude-code');
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: '/usr/local/bin/claude -p --model opus' }))).toBe(
      'claude-code',
    );
  });

  it("infers omp from an `omp`/`pi` binary when backend is 'auto'", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'omp -p' }))).toBe('omp');
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: '/home/u/.bun/bin/pi -p' }))).toBe('omp');
  });

  it("defaults 'auto' with an unrecognized binary to omp", () => {
    expect(effectiveBackend(cfg({ backend: 'auto', cmd: 'wrapper.sh' }))).toBe('omp');
  });
});

describe('parseSurfaceModels (OQ3)', () => {
  it('keeps known surfaces mapped to non-empty model ids, trimmed', () => {
    expect(parseSurfaceModels({ operator: ' gpt-5.5 ', oracle: 'claude-opus-4-7' })).toEqual({
      operator: 'gpt-5.5',
      oracle: 'claude-opus-4-7',
    });
  });

  it('drops unknown surface keys + empty/non-string values', () => {
    expect(parseSurfaceModels({ nope: 'x', operator: '', scanner: '  ', plans: 42 as unknown as string })).toEqual({});
  });

  it('returns {} for non-object input', () => {
    expect(parseSurfaceModels(null)).toEqual({});
    expect(parseSurfaceModels(['a'])).toEqual({});
  });
});

describe('parseBackends (drift guard for the SurfaceKey set)', () => {
  it('keeps known surfaces mapped to concrete subprocess backends', () => {
    expect(parseBackends({ operator: 'codex', oracle: 'claude-code', plans: 'omp' })).toEqual({
      operator: 'codex',
      oracle: 'claude-code',
      plans: 'omp',
    });
  });

  it("drops 'auto' / unknown backends + unknown surfaces", () => {
    expect(parseBackends({ operator: 'auto', nope: 'omp', scanner: 'gemini' })).toEqual({});
  });
});

describe('parseRoleBackends', () => {
  it('keeps non-empty role keys mapped to concrete subprocess backends', () => {
    expect(parseRoleBackends({ queen: 'codex', 'release-manager': 'omp', overwatch: 'claude-code' })).toEqual({
      queen: 'codex',
      'release-manager': 'omp',
      overwatch: 'claude-code',
    });
  });

  it("drops empty role keys plus 'auto' / unknown backends", () => {
    expect(parseRoleBackends({ queen: 'auto', '': 'omp', nope: 'gemini' })).toEqual({});
  });
});

describe('parseTiers / parseTierCeilings (queen-model-tier-selection P-002)', () => {
  it('keeps valid { name, spec } entries in order; drops dupes (case-insensitive), bad specs, junk', () => {
    expect(
      parseTiers([
        { name: 'quick', spec: 'haiku' },
        { name: 'deep', spec: 'opus:high' },
        { name: 'Quick', spec: 'sonnet' }, // dup name (case-insensitive)
        { name: 'bad', spec: 'has space' }, // invalid spec
        { name: '', spec: 'sonnet' }, // empty name
        { name: 'x' }, // missing spec
        'junk',
      ]),
    ).toEqual([
      { name: 'quick', spec: 'haiku' },
      { name: 'deep', spec: 'opus:high' },
    ]);
    expect(parseTiers(undefined)).toEqual([]);
    expect(parseTiers({ not: 'array' })).toEqual([]);
  });

  it('keeps a known backend on a tier row; drops an unknown one (row survives as inherit)', () => {
    expect(
      parseTiers([
        { name: 'eco', spec: 'haiku', backend: 'omp' },
        { name: 'turbo', spec: 'opus:max', backend: 'gemini' },
      ]),
    ).toEqual([
      { name: 'eco', spec: 'haiku', backend: 'omp' },
      { name: 'turbo', spec: 'opus:max' },
    ]);
  });

  it('keeps the per-tier when guidance, trimmed and capped', () => {
    expect(parseTiers([{ name: 'eco', spec: 'haiku', when: '  cheap sweeps  ' }])).toEqual([
      { name: 'eco', spec: 'haiku', when: 'cheap sweeps' },
    ]);
    const long = 'x'.repeat(500);
    expect(parseTiers([{ name: 'eco', spec: 'haiku', when: long }])[0].when).toHaveLength(300);
  });

  it('ceilings: keeps role→tier-name entries; drops names absent from a NON-EMPTY menu', () => {
    const tiers = [
      { name: 'quick', spec: 'haiku' },
      { name: 'deep', spec: 'opus' },
    ];
    expect(parseTierCeilings({ bee: 'deep', worker: 'nope', '': 'deep', queen: 7 }, tiers)).toEqual({ bee: 'deep' });
    // empty menu → names can't be checked; kept as-is (resolution ignores unknowns anyway)
    expect(parseTierCeilings({ bee: 'whatever' }, [])).toEqual({ bee: 'whatever' });
    expect(parseTierCeilings(null, tiers)).toEqual({});
  });
});

// ── context-trimming-tiers-2026-07-01: per-tier compaction limits ────────────

describe('parseTiers compactionLimit (context-trimming-tiers D-001/D-002)', () => {
  it('keeps a valid limit; drops the FIELD (not the row) for a non-number', () => {
    expect(parseTiers([{ name: 'std', spec: 'sonnet', compactionLimit: 120_000 }])).toEqual([
      { name: 'std', spec: 'sonnet', compactionLimit: 120_000 },
    ]);
    expect(parseTiers([{ name: 'std', spec: 'sonnet', compactionLimit: 'lots' }])).toEqual([
      { name: 'std', spec: 'sonnet' },
    ]);
    expect(parseTiers([{ name: 'std', spec: 'sonnet', compactionLimit: NaN }])).toEqual([
      { name: 'std', spec: 'sonnet' },
    ]);
  });

  it('clamps to the spec-derived ceiling: 200k window caps at 158k, any [1m] spec at the uniform 400k spend cap', () => {
    // (window − 10k margin) ÷ 1.2 — the 20% overshoot allowance (D-001).
    expect(parseTiers([{ name: 'std', spec: 'haiku', compactionLimit: 900_000 }])).toEqual([
      { name: 'std', spec: 'haiku', compactionLimit: 158_000 },
    ]);
    // EVERY [1m]-marked spec caps at 400k — the cap is keyed on the marker
    // (the actual window signal), not the model family, so it compacts
    // preemptively despite the 1M window (owner directive 2026-07-03).
    expect(parseTiers([{ name: 'vast', spec: 'haiku[1m]', compactionLimit: 900_000 }])).toEqual([
      { name: 'vast', spec: 'haiku[1m]', compactionLimit: 400_000 },
    ]);
    expect(parseTiers([{ name: 'deep', spec: 'opus[1m]:high', compactionLimit: 900_000 }])).toEqual([
      { name: 'deep', spec: 'opus[1m]:high', compactionLimit: 400_000 },
    ]);
    // floor clamp
    expect(parseTiers([{ name: 'std', spec: 'haiku', compactionLimit: 5 }])).toEqual([
      { name: 'std', spec: 'haiku', compactionLimit: 20_000 },
    ]);
  });

  it('preserves a backend-catalog window and clamps against that real window', () => {
    expect(
      parseTiers([
        {
          name: 'ox-alpha',
          spec: 'openrouter/stealth/ox-alpha:max',
          backend: 'omp',
          contextWindow: 1_048_576,
          compactionLimit: 400_000,
        },
      ]),
    ).toEqual([
      {
        name: 'ox-alpha',
        spec: 'openrouter/stealth/ox-alpha:max',
        backend: 'omp',
        contextWindow: 1_048_576,
        compactionLimit: 400_000,
      },
    ]);
  });
});

describe('agentCmdBootWarning (EI-727)', () => {
  it('warns when both AGENT_CMD and CLAUDE are unset (the silent omp -p fallback)', () => {
    const msg = agentCmdBootWarning({});
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/omp -p/);
    expect(msg).toMatch(/EI-727/);
  });

  it('stays silent once AGENT_CMD is set', () => {
    expect(agentCmdBootWarning({ AGENT_CMD: 'claude -p' })).toBeNull();
  });

  it('stays silent once CLAUDE is set (legacy var)', () => {
    expect(agentCmdBootWarning({ CLAUDE: 'claude -p' })).toBeNull();
  });

  it('an empty-string override still counts as unset (falsy, same as env-var semantics)', () => {
    expect(agentCmdBootWarning({ AGENT_CMD: '', CLAUDE: '' })).toBeTruthy();
  });
});
