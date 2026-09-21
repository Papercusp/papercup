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
import { downgradeOpusTierForBudget, effectiveTierConfig, resolveTierSpec, roleDefaultSpec, roleHomeTier, resolveRoleOwnModelSpec, specFamilyKey, specModelClass, specModelId, tierMenuLines } from './model-tiers';

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
    // WI-4623 revert (owner decision 2026-07-16): cup's committed floor is the
    // autonomous-loop sonnet-5 trimmed tier — the bare `sonnet[1m]:high`.
    expect(roleDefaultSpec('cup')).toBe('sonnet[1m]:high');
    expect(roleDefaultSpec('release-manager')).toBe('opus:xhigh');
    // The launch-fixer family's committed floors (git-sync-content-guard D-008
    // follow-up): the two fleet-blast-radius fixers pin opus:xhigh — merge-resolver
    // no longer silently downgrades on a host without AGENT_MODELS — and the bounded
    // content repairer pinned the sonnet execution tier until 2026-09-02, when an owner
    // directive (interactive) moved it — and every other role carrying an
    // operator_agent_config roleBackends entry — onto opus:xhigh.
    expect(roleDefaultSpec('merge-resolver')).toBe('opus:xhigh');
    expect(roleDefaultSpec('release-fixer')).toBe('opus:xhigh');
    expect(roleDefaultSpec('content-fixer')).toBe('opus:xhigh');
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
    expect((r as { error: string }).error).toContain('quick, standard, deep, luna, max');
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
    // `worker` — a sonnet-floored execution role — so a `max` pick clamps DOWN to the
    // sonnet `standard` ceiling: a plain ceiling clamp, not the floor-outranks-ceiling
    // path.
    const r = resolveTierSpec({ tier: 'max', role: 'worker', tierCeilings: { worker: 'standard' } });
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

  // WI-7340. This case previously asserted the OPPOSITE ("yields no floor (no
  // clamp)") — an off-menu role default let ANY pick through unclamped, so
  // release-manager (committed opus:xhigh for deploy-gate blast radius) silently
  // resolved to haiku, the exact downgrade EI-7/EI-286 exists to prevent. The
  // behavior was changed deliberately, not fixed by accident: with the default
  // off the ladder there is no basis to rank it, so the role freezes on its own
  // default rather than moving to an unrankable pick.
  const noOpus = [{ name: 'eco', spec: 'haiku' }, { name: 'normal', spec: 'sonnet' }];

  it('OFF-LADDER FLOOR: a role default absent from the menu freezes the role on that default', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // release-manager default opus:xhigh — no opus tier in this menu.
    const r = resolveTierSpec({ tier: 'eco', role: 'release-manager', tiers: noOpus });
    expect(r).toMatchObject({ ok: true, spec: 'opus:xhigh', tier: 'role-default', requestedTier: 'eco', clamped: 'floor' });
    expect((r as { note: string }).note).toContain('not on the configured tier menu');
  });

  it('OFF-LADDER FLOOR outranks a ceiling too (no common rank ⇒ staying put is the only safe choice)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'normal', role: 'release-manager', tiers: noOpus, tierCeilings: { 'release-manager': 'eco' } });
    expect(r).toMatchObject({ ok: true, spec: 'opus:xhigh', tier: 'role-default', clamped: 'floor' });
  });

  it('OFF-LADDER FLOOR is distinct from NO default: an empty default still takes any tier unclamped', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // Both reach tierRankOfSpec === -1; only the off-ladder one has a floor to
    // protect, so collapsing the two would wrongly freeze floorless roles.
    const r = resolveTierSpec({ tier: 'eco', role: 'reviewer', tiers: noOpus });
    expect(r).toMatchObject({ ok: true, spec: 'haiku', tier: 'eco' });
    expect(r).not.toHaveProperty('clamped');
  });

  it('an unknown tier still fails LOUD for an off-ladder role (caller bug ≠ frozen resolution)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const r = resolveTierSpec({ tier: 'nope', role: 'release-manager', tiers: noOpus });
    expect(r.ok).toBe(false);
  });

  it('OFF-LADDER FLOOR composes with resolveRoleOwnModelSpec as "no override"', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // The menu must NAME release-manager's home tier ('deep') for this to reach
    // the freeze path at all — with a menu lacking that name, resolveTierSpec
    // fails on the unknown tier and returns null for an unrelated reason, so
    // the assertion would pass while testing nothing.
    const deepIsHaiku = [{ name: 'deep', spec: 'haiku' }];
    expect(resolveTierSpec({ tier: 'deep', role: 'release-manager', tiers: deepIsHaiku })).toMatchObject({ clamped: 'floor', spec: 'opus:xhigh' });
    // clamped:'floor' is the documented no-override signal, so an off-ladder
    // role never has its committed pin replaced by a weaker menu row.
    expect(resolveRoleOwnModelSpec('release-manager', { tiers: deepIsHaiku })).toBeNull();
  });

  it('OFF-LADDER FLOOR allows a STRONGER pick — the owner own-model lever still works', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // cup defaults to sonnet, absent from this one-row menu, so this lands on
    // the off-ladder path too. Freezing every unrankable floor would refuse the
    // very escalation the lever exists for, so only a weaker class is clamped.
    const r = resolveTierSpec({ tier: 'standard', role: 'cup', tiers: [{ name: 'standard', spec: 'opus:xhigh' }] });
    expect(r).toMatchObject({ ok: true, spec: 'opus:xhigh', tier: 'standard' });
    expect(r).not.toHaveProperty('clamped');
  });

  it('OFF-LADDER FLOOR left unenforced is LOUD: a cross-provider pick resolves but carries a note', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // gpt-5.5 is not rankable against the Claude ladder, so the pick stands as
    // explicit owner intent — but the unenforced floor is reported rather than
    // passing silently, which was the actual defect in WI-7340.
    const r = resolveTierSpec({ tier: 'standard', role: 'cup', tiers: [{ name: 'standard', spec: 'gpt-5.5:high' }] });
    expect(r).toMatchObject({ ok: true, spec: 'gpt-5.5:high' });
    expect(r).not.toHaveProperty('clamped');
    expect((r as { note?: string }).note).toContain('could NOT be enforced');
  });

  it('an empty tiers array falls back to the default menu', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // `worker` — a sonnet-floored execution role — so a `standard` pick resolves
    // unclamped and this purely exercises the empty-array→default-menu fallback.
    expect(resolveTierSpec({ tier: 'standard', role: 'worker', tiers: [] })).toMatchObject({ ok: true, spec: 'sonnet[1m]' });
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
    // WI-4623 revert: cup's committed floor is the sonnet-5 trimmed spec
    // (`sonnet[1m]:high`), which maps to the sonnet 'standard' tier — the same
    // home tier as worker (a pipeline execution role also on the sonnet family).
    expect(roleHomeTier('worker')).toBe('standard'); // sonnet → standard
    expect(roleHomeTier('cup')).toBe('standard'); // sonnet[1m]:high → standard
    // ⚠ mug MOVED OUT of the standard tier on 2026-09-02 (owner directive, interactive):
    // its committed default is now opus:xhigh, so its home tier is `deep`. Asserted
    // explicitly because this is a real behavioural consequence, not a renamed constant —
    // roleHomeTier is what the opus-budget downgrade (B-GW-4) and the queen own-model
    // lever both key on, so mug/kettle/scanner now sit above the downgrade threshold.
    expect(roleHomeTier('mug')).toBe('deep'); // opus:xhigh → deep
  });

  it('treats the current versioned Claude id and its stable menu alias as one family', () => {
    expect(specFamilyKey('sonnet-5[1m]:high')).toBe(specFamilyKey('sonnet[1m]'));
  });
  it('undefined for a role with no committed default (no own-model resolution)', () => {
    expect(roleHomeTier('reviewer')).toBeUndefined();
  });
});

describe('resolveRoleOwnModelSpec — the GAP-2 queen own-model lever (queen-steering-panel)', () => {
  it('returns null on the default menu (queen home=standard=sonnet family) — a marker-only difference is NOT an override; [1m] rides the exec boundary (applyRoleModel)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveRoleOwnModelSpec('cup', {})).toBeNull();
  });

  // ⚠ FIXTURE NOTE (2026-09-02): these cases use `cup` as the standard-tier role. They
  // used `mug` until an owner directive (interactive) moved mug/kettle/scanner to
  // opus:xhigh, which lifted mug's home tier from `standard` to `deep`. The subject here
  // is the OWN-MODEL LEVER against a standard-tier role, not mug specifically, so the
  // fixture moved to a role still on `sonnet[1m]:high` rather than weakening the
  // assertions. mug's new home tier is asserted directly in the roleHomeTier block above.
  it('an owner menu override that raises the standard (cup home) tier MOVES the queen', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // WI-4623 revert: cup's home tier is `standard` (sonnet[1m]:high), not `luna`.
    const eff = { tiers: [{ name: 'standard', spec: 'opus:xhigh' }] };
    expect(resolveRoleOwnModelSpec('cup', eff)).toBe('opus:xhigh');
  });

  it('same-family owner rows can raise effort but never weaken the committed role floor', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // WI-4623 revert: cup's committed default is sonnet[1m]:high — a marker-only /
    // identical-effort menu row is not an override; a raised effort is.
    expect(resolveRoleOwnModelSpec('cup', { tiers: [{ name: 'standard', spec: 'sonnet:high' }] })).toBeNull();
    expect(resolveRoleOwnModelSpec('cup', { tiers: [{ name: 'standard', spec: 'sonnet:xhigh' }] })).toBe('sonnet:xhigh');
  });

  it('allows cross-provider own-model menu specs; invoke infers the backend from the model spec', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const eff = { tiers: [{ name: 'standard', spec: 'gpt-5.5:high' }] };
    expect(resolveRoleOwnModelSpec('cup', eff)).toBe('gpt-5.5:high');
  });

  it('allows role-own tier rows that name a non-Claude backend', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const eff = { tiers: [{ name: 'standard', spec: 'gpt-5.5:high', backend: 'codex' as const }] };
    expect(resolveRoleOwnModelSpec('cup', eff)).toBe('gpt-5.5:high');
  });

  it('a queen CEILING is her TARGET (a decider has no self-picker) — ceiling=max → opus:xhigh', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveRoleOwnModelSpec('cup', { tierCeilings: { cup: 'max' } })).toBe('opus[1m]:xhigh');
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

  it('downgrades to sonnet for a role with NO committed floor — sonnet is unclamped', () => {
    // cup/scanner/judge sit on the sonnet-5 trimmed floor (WI-4623 revert), not haiku —
    // per the ROLE_MODEL_DEFAULTS comment no role currently occupies the haiku volume
    // tier, so this exercises the no-committed-floor case (`reviewer`) instead of a
    // genuine haiku floor.
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const d = downgradeOpusTierForBudget({ currentSpec: 'opus:xhigh', currentTier: 'max', role: 'reviewer' });
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
    // `worker`, not `cup` — cup's own floor is now `luna` (P-020), which would clamp
    // a `standard` pick up past it; worker stays sonnet-floored.
    const r = resolveTierSpec({ tier: 'standard', role: 'worker' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.compactionLimit).toBe(450_000); // standard = sonnet[1m] → the [1m] leader/solo cap (450k, owner directive 2026-09-21)
  });

  it('honors an explicit per-tier limit and reflects a [1m] window', () => {
    // `reviewer` — a floorless role — so this isolates the per-tier compactionLimit
    // derivation without any role-floor clamp perturbing which tier resolves.
    const tiers = [
      { name: 'vast', spec: 'haiku[1m]' },
      { name: 'lean', spec: 'sonnet', compactionLimit: 90_000 },
      { name: 'wide', spec: 'opus[1m]:high' },
    ];
    const lean = resolveTierSpec({ tier: 'lean', role: 'reviewer', tiers });
    expect(lean.ok && lean.compactionLimit).toBe(90_000);
    const vast = resolveTierSpec({ tier: 'vast', role: 'reviewer', tiers });
    expect(vast.ok && vast.compactionLimit).toBe(450_000); // [1m] ⇒ the uniform leader/solo spend cap (marker-keyed; 450k since owner directive 2026-09-21)
    const wide = resolveTierSpec({ tier: 'wide', role: 'reviewer', tiers });
    expect(wide.ok && wide.compactionLimit).toBe(450_000); // [1m] ⇒ 450k cap (owner directive 2026-09-21, raising the 2026-07-03 400k)
  });

  it('derives a wide default from a backend-catalog tier window', () => {
    const tiers = [{
      name: 'ox-alpha', spec: 'openrouter/stealth/ox-alpha:max', backend: 'omp' as const,
      contextWindow: 1_048_576,
    }];
    const r = resolveTierSpec({ tier: 'ox-alpha', role: 'reviewer', tiers });
    expect(r.ok && r.compactionLimit).toBe(450_000); // 1M backend window ⇒ the leader/solo cap (450k, owner directive 2026-09-21)
  });

  it('a budget downgrade adopts the downgraded-to tier limit', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ cup: 'haiku' }));
    const dg = downgradeOpusTierForBudget({ currentSpec: 'opus:xhigh', currentTier: 'max', role: 'cup' });
    expect(dg.downgraded).toBe(true);
    expect(dg.compactionLimit).toBe(450_000); // standard target = sonnet[1m] → the [1m] leader/solo cap (450k, owner directive 2026-09-21)
  });
});
