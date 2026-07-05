/**
 * Coverage for resolveTierSpec — the tier-name → model-spec resolution with
 * [role floor, role ceiling] clamping (queen-model-tier-selection-2026-06-11
 * P-002). The load-bearing semantics:
 *   - floor derives from the role's resolved default (AGENT_MODELS →
 *     ROLE_MODEL_DEFAULTS): a tier can escalate a role, never downgrade it
 *     below what it runs with no tier at all (EI-7/EI-286);
 *   - ceiling is the user's per-role envelope; floor outranks a ceiling
 *     configured below it;
 *   - unknown tier name fails loud (a typo'd tier silently running at the
 *     default would be the EI-7 class of bug); clamps never error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downgradeOpusTierForBudget, effectiveTierConfig, resolveTierSpec, roleDefaultSpec, roleHomeTier, resolveRoleOwnModelSpec, specModelClass, specModelId, tierMenuLines } from './model-tiers';

afterEach(() => vi.unstubAllEnvs());

describe('specModelId', () => {
  it('strips a known effort suffix, keeps a non-effort colon suffix', () => {
    expect(specModelId('opus:xhigh')).toBe('opus');
    expect(specModelId('sonnet')).toBe('sonnet');
    expect(specModelId('vendor/model:7b')).toBe('vendor/model:7b');
  });
});

describe('roleDefaultSpec — the floor input', () => {
  it('AGENT_MODELS entry wins; committed default is the fallback; neither → empty', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ cup: 'sonnet' }));
    expect(roleDefaultSpec('cup')).toBe('sonnet');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(roleDefaultSpec('cup')).toBe('haiku');
    expect(roleDefaultSpec('release-manager')).toBe('opus:xhigh');
    // The launch-fixer family's committed floors (git-sync-content-guard D-008
    // follow-up): the two fleet-blast-radius fixers pin opus:xhigh — merge-resolver
    // no longer silently downgrades on a host without AGENT_MODELS — and the bounded
    // content repairer pins the sonnet execution tier.
    expect(roleDefaultSpec('merge-resolver')).toBe('opus:xhigh');
    expect(roleDefaultSpec('release-fixer')).toBe('opus:xhigh');
    expect(roleDefaultSpec('content-fixer')).toBe('sonnet');
    // A role with neither an env entry nor a committed default → empty.
    expect(roleDefaultSpec('reviewer')).toBe('');
  });
});

describe('resolveTierSpec — default menu (quick < standard < deep < max)', () => {
  it('resolves a tier for a role at/below it (no clamp)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'deep', role: 'worker' });
    expect(r).toMatchObject({ ok: true, spec: 'opus[1m]:high', tier: 'deep' });
    expect((r as { clamped?: string }).clamped).toBeUndefined();
  });

  it('tier names are case-insensitive', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveTierSpec({ tier: 'MAX', role: 'cup' })).toMatchObject({ ok: true, spec: 'opus[1m]:xhigh', tier: 'max' });
  });

  it('unknown tier fails LOUD, listing the valid menu', () => {
    const r = resolveTierSpec({ tier: 'turbo', role: 'cup' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('quick, standard, deep, max');
  });

  it('FLOOR: a pick below the role default clamps UP (worker default sonnet, pick quick → standard)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'quick', role: 'worker' });
    expect(r).toMatchObject({ ok: true, spec: 'sonnet[1m]', tier: 'standard', clamped: 'floor' });
  });

  it('FLOOR follows an AGENT_MODELS escalation (bee pinned to opus → quick clamps to deep)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ cup: 'opus' }));
    const r = resolveTierSpec({ tier: 'quick', role: 'cup' });
    expect(r).toMatchObject({ ok: true, spec: 'opus[1m]:high', tier: 'deep', clamped: 'floor' });
  });

  it('a role with no resolvable default (no floor) takes any tier unclamped', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // `reviewer` is a judgment role with no committed ROLE_MODEL_DEFAULTS floor
    // (merge-resolver used to serve here, but it now pins opus:xhigh — D-008 follow-up).
    const r = resolveTierSpec({ tier: 'quick', role: 'reviewer' });
    expect(r).toMatchObject({ ok: true, spec: 'haiku', tier: 'quick' });
  });

  it('CEILING: a pick above the role ceiling clamps DOWN', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'max', role: 'cup', tierCeilings: { cup: 'standard' } });
    expect(r).toMatchObject({ ok: true, spec: 'sonnet[1m]', tier: 'standard', clamped: 'ceiling' });
  });

  it('FLOOR outranks a ceiling configured BELOW the role default (never a downgrade)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // worker default = sonnet (standard); ceiling says quick; pick max.
    const r = resolveTierSpec({ tier: 'max', role: 'worker', tierCeilings: { worker: 'quick' } });
    expect(r).toMatchObject({ ok: true, spec: 'sonnet[1m]', tier: 'standard', clamped: 'floor' });
  });

  it('an unknown ceiling name is ignored (config bug ≠ runtime failure)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'max', role: 'cup', tierCeilings: { cup: 'nope' } });
    expect(r).toMatchObject({ ok: true, spec: 'opus[1m]:xhigh', tier: 'max' });
  });
});

describe('resolveTierSpec — user-defined menu', () => {
  const tiers = [
    { name: 'eco', spec: 'haiku' },
    { name: 'normal', spec: 'sonnet:high' },
    { name: 'turbo', spec: 'claude-opus-4-8:max' },
  ];

  it('resolves against the custom menu (the default names are gone)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveTierSpec({ tier: 'turbo', role: 'cup', tiers })).toMatchObject({
      ok: true, spec: 'claude-opus-4-8:max', tier: 'turbo',
    });
    expect(resolveTierSpec({ tier: 'standard', role: 'cup', tiers }).ok).toBe(false);
  });

  it('floor matches by MODEL ID within the custom menu (worker default sonnet → normal)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'eco', role: 'worker', tiers });
    expect(r).toMatchObject({ ok: true, spec: 'sonnet:high', tier: 'normal', clamped: 'floor' });
  });

  it('a role default whose model id is NOT in the menu yields no floor (no clamp)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // release-manager default opus:xhigh — no opus tier in this menu.
    const noOpus = [{ name: 'eco', spec: 'haiku' }, { name: 'normal', spec: 'sonnet' }];
    const r = resolveTierSpec({ tier: 'eco', role: 'release-manager', tiers: noOpus });
    expect(r).toMatchObject({ ok: true, spec: 'haiku', tier: 'eco' });
  });

  it('an empty tiers array falls back to the default menu', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveTierSpec({ tier: 'standard', role: 'cup', tiers: [] })).toMatchObject({ ok: true, spec: 'sonnet[1m]' });
  });

  it('per-tier backend rides the resolution — including through a clamp', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const withBackends = [
      { name: 'eco', spec: 'haiku', backend: 'omp' as const },
      { name: 'normal', spec: 'sonnet' },
      { name: 'turbo', spec: 'opus:max', backend: 'claude-code' as const },
    ];
    // direct pick carries its backend
    expect(resolveTierSpec({ tier: 'turbo', role: 'cup', tiers: withBackends })).toMatchObject({
      ok: true, spec: 'opus:max', backend: 'claude-code',
    });
    // backend-less tier has no backend field
    const normal = resolveTierSpec({ tier: 'normal', role: 'cup', tiers: withBackends });
    expect((normal as { backend?: string }).backend).toBeUndefined();
    // a floor clamp adopts the clamped-TO tier's backend (worker floor=sonnet → 'normal', no backend)
    const clamped = resolveTierSpec({ tier: 'eco', role: 'worker', tiers: withBackends });
    expect(clamped).toMatchObject({ ok: true, tier: 'normal', clamped: 'floor' });
    expect((clamped as { backend?: string }).backend).toBeUndefined();
  });
});

describe('tierMenuLines — the queen-facing live menu (runtime context)', () => {
  it('renders the user menu with names, specs, and the per-tier when guidance', () => {
    const lines = tierMenuLines(
      [
        { name: 'eco', spec: 'haiku', when: 'cheap sweeps only' },
        { name: 'turbo', spec: 'fable:xhigh', backend: 'claude-code', when: 'security work' },
      ],
      { cup: 'eco' },
    );
    const joined = lines.join('\n');
    expect(joined).toContain('MODEL TIERS');
    expect(joined).toContain('- eco (haiku) — cheap sweeps only');
    expect(joined).toContain('- turbo (fable:xhigh) — security work');
    expect(joined).toContain('TIER CEILINGS');
    expect(joined).toContain('cup≤eco');
  });

  it('falls back to the default menu (with its default rubric) when no user menu exists', () => {
    const joined = tierMenuLines([]).join('\n');
    expect(joined).toContain('- quick (haiku)');
    expect(joined).toContain('- max (opus[1m]:xhigh)');
    expect(joined).toContain('trivial / mechanical');
    expect(joined).not.toContain('TIER CEILINGS');
  });
});

describe('effectiveTierConfig — session override precedence (queen-steering D-006)', () => {
  const wsTiers = [{ name: 'std', spec: 'sonnet' }];
  const wsCeilings = { worker: 'std' };

  it('a session model-tier override wins over the workspace default', () => {
    const session = { modelTiers: [{ name: 'std', spec: 'opus:xhigh' }], tierCeilings: null };
    const eff = effectiveTierConfig({ tiers: wsTiers, tierCeilings: wsCeilings }, session);
    expect(eff.tiers).toEqual([{ name: 'std', spec: 'opus:xhigh' }]); // session
    expect(eff.tierCeilings).toEqual(wsCeilings); // null override ⇒ workspace default
  });

  it('a null / empty override leaves each field on the workspace default', () => {
    expect(effectiveTierConfig({ tiers: wsTiers, tierCeilings: wsCeilings }, null)).toEqual({ tiers: wsTiers, tierCeilings: wsCeilings });
    expect(effectiveTierConfig({ tiers: wsTiers }, { modelTiers: [], tierCeilings: {} })).toEqual({ tiers: wsTiers, tierCeilings: undefined });
  });

  it('a session ceilings override wins independently of the tier menu', () => {
    const eff = effectiveTierConfig({ tiers: wsTiers, tierCeilings: wsCeilings }, { modelTiers: null, tierCeilings: { worker: 'std', cup: 'std' } });
    expect(eff.tiers).toEqual(wsTiers); // null menu override ⇒ workspace default
    expect(eff.tierCeilings).toEqual({ worker: 'std', cup: 'std' }); // session
  });
});

describe('roleHomeTier — the default-menu tier a role runs at', () => {
  it('maps a committed default spec to its default-menu tier name', () => {
    expect(roleHomeTier('mug')).toBe('standard'); // sonnet → standard
    expect(roleHomeTier('worker')).toBe('standard'); // sonnet → standard
    expect(roleHomeTier('cup')).toBe('quick'); // haiku → quick
  });
  it('undefined for a role with no committed default (no own-model resolution)', () => {
    expect(roleHomeTier('reviewer')).toBeUndefined();
  });
});

describe('resolveRoleOwnModelSpec — the GAP-2 queen own-model lever (queen-steering-panel)', () => {
  it('returns null on the default menu (queen home=standard=sonnet family) — a marker-only difference is NOT an override; [1m] rides the exec boundary (applyRoleModel)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveRoleOwnModelSpec('mug', {})).toBeNull();
  });

  it('an owner menu override that raises the standard tier MOVES the queen', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const eff = { tiers: [{ name: 'standard', spec: 'opus:xhigh' }] };
    expect(resolveRoleOwnModelSpec('mug', eff)).toBe('opus:xhigh');
  });

  it('allows cross-provider own-model menu specs; invoke infers the backend from the model spec', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const eff = { tiers: [{ name: 'standard', spec: 'gpt-5.5:high' }] };
    expect(resolveRoleOwnModelSpec('mug', eff)).toBe('gpt-5.5:high');
  });

  it('allows role-own tier rows that name a non-Claude backend', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const eff = { tiers: [{ name: 'standard', spec: 'gpt-5.5:high', backend: 'codex' as const }] };
    expect(resolveRoleOwnModelSpec('mug', eff)).toBe('gpt-5.5:high');
  });

  it('a queen CEILING is her TARGET (a decider has no self-picker) — ceiling=max → opus:xhigh', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveRoleOwnModelSpec('mug', { tierCeilings: { mug: 'max' } })).toBe('opus[1m]:xhigh');
  });

  it('a too-low ceiling NEVER downgrades the queen below her floor (EI-7/EI-286) → null (stays default; marker-only diff ≠ override)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // queen floor = standard (sonnet family); ceiling 'quick' (haiku) clamps UP to standard → sonnet[1m] ≈ committed 'sonnet' → null.
    expect(resolveRoleOwnModelSpec('mug', { tierCeilings: { mug: 'quick' } })).toBeNull();
  });

  it('null for a role with no home tier (no committed default)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveRoleOwnModelSpec('reviewer', { tiers: [{ name: 'standard', spec: 'opus:xhigh' }] })).toBeNull();
  });
});

describe('specModelClass', () => {
  it('classifies opus/sonnet/haiku/other', () => {
    expect(specModelClass('opus:xhigh')).toBe('opus');
    expect(specModelClass('opus:high')).toBe('opus');
    expect(specModelClass('sonnet')).toBe('sonnet');
    expect(specModelClass('haiku')).toBe('haiku');
    expect(specModelClass('vendor/model:7b')).toBe('other');
  });
});

describe('downgradeOpusTierForBudget — floor-safe opus→sonnet shed (B-GW-4)', () => {
  it('downgrades an opus escalation to sonnet for a SONNET-floored role (worker)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // worker floor = sonnet; an opus escalation (deep) sheds back to standard/sonnet.
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:high', currentTier: 'deep', role: 'worker' });
    expect(d.downgraded).toBe(true);
    expect(specModelClass(d.spec)).toBe('sonnet');
    expect(d.from).toBe('opus:high');
    expect(d.tier).toBe('standard');
  });

  it('downgrades to sonnet for a HAIKU-floored role (bee) — sonnet is still ≥ the haiku floor', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:xhigh', currentTier: 'max', role: 'cup' });
    expect(d.downgraded).toBe(true);
    expect(specModelClass(d.spec)).toBe('sonnet');
  });

  it('is a NO-OP for an OPUS-floored role (release-manager) — never drops below the role floor (EI-7/EI-286)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:xhigh', currentTier: 'max', role: 'release-manager' });
    expect(d.downgraded).toBe(false);
    expect(d.spec).toBe('opus:xhigh');
    expect(d.tier).toBe('max');
  });

  it('is a NO-OP when the current spec is already non-opus (nothing to shed)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const d = downgradeOpusTierForBudget({ currentSpec: 'sonnet', currentTier: 'standard', role: 'worker' });
    expect(d.downgraded).toBe(false);
    expect(d.spec).toBe('sonnet');
  });

  it('targets the strongest SONNET tier in a custom menu', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const tiers = [
      { name: 'lite', spec: 'sonnet' },
      { name: 'mid', spec: 'sonnet:high' },
      { name: 'big', spec: 'opus:high' },
    ];
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:high', currentTier: 'big', role: 'worker', tiers });
    expect(d.downgraded).toBe(true);
    expect(d.tier).toBe('mid'); // strongest sonnet entry
    expect(specModelClass(d.spec)).toBe('sonnet');
  });

  it('leaves opus unchanged when a custom menu has no sonnet entry (no safe target)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const tiers = [
      { name: 'cheap', spec: 'haiku' },
      { name: 'big', spec: 'opus:high' },
    ];
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:high', currentTier: 'big', role: 'worker', tiers });
    // 'standard' isn't in this menu → resolveTierSpec errors → unchanged (never silently haiku).
    expect(d.downgraded).toBe(false);
    expect(d.spec).toBe('opus:high');
  });
});

// ── context-trimming-tiers-2026-07-01: resolved tiers carry a compaction limit ─

describe('resolveTierSpec compactionLimit', () => {
  it('derives the model default from the resolved spec when the tier sets none', () => {
    const r = resolveTierSpec({ tier: 'standard', role: 'cup' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.compactionLimit).toBe(400_000); // standard = sonnet[1m] → the [1m] 400k cap
  });

  it('honors an explicit per-tier limit and reflects a [1m] window', () => {
    // Ordered weakest → strongest (the order IS the floor ranking): the haiku
    // tier must come FIRST or bee's haiku floor ([1m]-insensitive family
    // match) clamps a weaker-ranked pick up past it.
    const tiers = [
      { name: 'vast', spec: 'haiku[1m]' },
      { name: 'lean', spec: 'sonnet', compactionLimit: 90_000 },
      { name: 'wide', spec: 'opus[1m]:high' },
    ];
    const lean = resolveTierSpec({ tier: 'lean', role: 'cup', tiers });
    expect(lean.ok && lean.compactionLimit).toBe(90_000);
    const vast = resolveTierSpec({ tier: 'vast', role: 'cup', tiers });
    expect(vast.ok && vast.compactionLimit).toBe(400_000); // [1m] ⇒ the uniform 400k spend cap (marker-keyed, 2026-07-03)
    const wide = resolveTierSpec({ tier: 'wide', role: 'cup', tiers });
    expect(wide.ok && wide.compactionLimit).toBe(400_000); // [1m] ⇒ 400k cap (owner directive 2026-07-03)
  });

  it('a budget downgrade adopts the downgraded-to tier limit', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ cup: 'haiku' }));
    const dg = downgradeOpusTierForBudget({ currentSpec: 'opus:xhigh', currentTier: 'max', role: 'cup' });
    expect(dg.downgraded).toBe(true);
    expect(dg.compactionLimit).toBe(400_000); // standard target = sonnet[1m] → the [1m] 400k cap
  });
});
