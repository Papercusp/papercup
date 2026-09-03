import { describe, expect, it } from 'vitest';
import {
  MODEL_WINDOW_1M,
  MODEL_WINDOW_DEFAULT,
  COMPACTION_LIMIT_DEFAULT_1M_CAP,
  COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
  modelWindowForSpec,
  isDefault1mModelSpec,
  defaultCompactionLimitForSpec,
  defaultCompactionLimitForWindow,
  supersededDerivedCompactionLimits,
  derivesFrom1mWindow,
  SUPERSEDED_1M_FLEET_MEMBER_CAPS,
  selfSetCeilingForWindow,
  selfSetCeilingForSpec,
  clampCompactionLimit,
  MIN_COMPACTION_LIMIT_TOKENS,
  validateCloudModelSpec,
  KNOWN_CLOUD_ALIASES,
  defaultBulkResolverLaunchProfiles,
  launchAgentBackendForModel,
  resolveBulkResolverLaunch,
  PUBLIC_PORTAL_AGENT_BASELINE,
} from './agent-config-constants';
import { ROLE_MODEL_DEFAULTS } from '@papercusp/orchestrator/role-models';

// opus + fable + sonnet-5 are LAUNCHED at the full 1M window — psu-launcher
// normalizeModelSpec injects the [1m] marker for all three families — and
// papercusp compacts [1m] sessions preemptively at 400k, fleet MEMBERS at 300k
// (owner directive 2026-07-03, revised from the 500k of 2026-07-02).
// Window/limit MATH keys on the [1m] MARKER only, never the bare
// family name: live-verified via /context on CC 2.1.198 (2026-07-02), a bare
// `sonnet` session runs a 200k AUTO-COMPACT window (auto-fires ~167k — killed
// a wave of sonnet fleet members), while `sonnet[1m]` runs 967k. This file
// pins BOTH halves: the family predicate (isDefault1mModelSpec — who gets
// normalized) and the marker-keyed math (modelWindowForSpec /
// defaultCompactionLimitForSpec / clampCompactionLimit).

describe('isDefault1mModelSpec (the FAMILY predicate the [1m] launch normalizer keys on)', () => {
  it('is true for opus and fable specs (with or without effort / id prefix)', () => {
    for (const spec of ['opus', 'opus:high', 'claude-opus-4-8', 'fable', 'claude-fable-5:xhigh']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is true for sonnet-5 — it NEEDS the [1m] marker injected (bare = 200k auto-compact window)', () => {
    for (const spec of ['claude-sonnet-5', 'claude-sonnet-5:high', 'sonnet-5', 'sonnet5:medium']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is true for the bare `sonnet` alias — CC resolves it to the latest sonnet, i.e. sonnet-5', () => {
    for (const spec of ['sonnet', 'sonnet:medium', 'sonnet[1m]', 'sonnet[1m]:high']) {
      expect(isDefault1mModelSpec(spec)).toBe(true);
    }
  });
  it('is false for versioned sonnet ≤4.x, other families, and nullish specs', () => {
    for (const spec of [
      'claude-sonnet-4-5',
      'claude-sonnet-4-6:high',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'haiku',
      'gpt-5.5',
      'ornith',
    ]) {
      expect(isDefault1mModelSpec(spec)).toBe(false);
    }
    expect(isDefault1mModelSpec(null)).toBe(false);
    expect(isDefault1mModelSpec(undefined)).toBe(false);
  });
});

describe('bulk resolver client-safe launch vocabulary', () => {
  it('defaults both panes to the exact pre-configuration launch behavior', () => {
    expect(defaultBulkResolverLaunchProfiles()).toEqual({
      'inbox-resolve': { model: null, effort: null, account: 'default', carry: 'warm' },
      'plan-cleanup': { model: null, effort: null, account: 'default', carry: 'warm' },
    });
  });

  it('derives the CLI from canonical aliases and OMP selectors, including effort specs', () => {
    expect(launchAgentBackendForModel('sonnet:high')).toBe('claude');
    expect(launchAgentBackendForModel('sol:xhigh')).toBe('codex');
    expect(launchAgentBackendForModel('openrouter/anthropic/claude-opus:max')).toBe('omp');
    expect(launchAgentBackendForModel(null)).toBeNull();
    expect(launchAgentBackendForModel('unknown-full-id')).toBeNull();
  });

  it('carries owner automation policy through the effective launch snapshot', () => {
    expect(
      resolveBulkResolverLaunch({
        model: 'sonnet',
        effort: 'high',
        account: 'default',
        carry: 'warm',
        automationMode: 'safe-medium-plus',
        minConfidence: 'medium',
      }),
    ).toMatchObject({
      ok: true,
      effective: { automationMode: 'safe-medium-plus', minConfidence: 'medium' },
    });
    expect(resolveBulkResolverLaunch({ automationMode: 'nope' } as never).ok).toBe(false);
  });

  it('derives Codex from canonical gpt-5.6 family ids, including effort and window markers', () => {
    for (const family of ['sol', 'terra', 'luna']) {
      expect(launchAgentBackendForModel(`gpt-5.6-${family}`), family).toBe('codex');
      expect(launchAgentBackendForModel(`gpt-5.6-${family}:xhigh`), `${family}:xhigh`).toBe('codex');
      expect(launchAgentBackendForModel(`gpt-5.6-${family}[1m]:high`), `${family}[1m]:high`).toBe('codex');
    }
    expect(launchAgentBackendForModel('GPT-5.6-SOL:HIGH')).toBe('codex');
  });
});

describe('modelWindowForSpec (keys on the [1m] MARKER only)', () => {
  it('an explicit [1m] marker means 1M for any family', () => {
    expect(modelWindowForSpec('haiku[1m]')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('opus[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('sonnet[1m]:medium')).toBe(MODEL_WINDOW_1M);
    expect(modelWindowForSpec('claude-fable-5[1m]:xhigh')).toBe(MODEL_WINDOW_1M);
  });
  it('a BARE default-1M-family spec is the conservative 200k — an un-normalized launch really runs a 200k auto-compact window (live-verified 2026-07-02)', () => {
    expect(modelWindowForSpec('opus')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-fable-5:xhigh')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-sonnet-5:high')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('sonnet:medium')).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('everything else (incl. null/haiku/sonnet ≤4.x) is the conservative 200k', () => {
    expect(modelWindowForSpec('haiku')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec('claude-sonnet-4-6:high')).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(null)).toBe(MODEL_WINDOW_DEFAULT);
    expect(modelWindowForSpec(undefined)).toBe(MODEL_WINDOW_DEFAULT);
  });
  it('official 1.05M Codex families resolve to exact 1M without widening mini/nano', () => {
    for (const spec of ['gpt-5.6-sol', 'terra:xhigh', 'luna', 'gpt-5.4']) {
      expect(modelWindowForSpec(spec), spec).toBe(MODEL_WINDOW_1M);
    }
    for (const spec of ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5']) {
      expect(modelWindowForSpec(spec), spec).toBe(MODEL_WINDOW_DEFAULT);
    }
  });
});

describe('selfSetCeilingForSpec — a DELIBERATE self-set may exceed the SEEDED default', () => {
  // Until 2026-08-08 COMPACTION_LIMIT_DEFAULT_1M_CAP was both the seeded default AND the
  // hard ceiling, so config:set-compaction-limit could never do the one thing its own
  // description promises ("raise it for wide-context work") on this fleet's default spec.
  it('[1m] self-set reaches the real window-derived max (825k), not the 400k default', () => {
    const windowDerived1m = Math.floor((MODEL_WINDOW_1M - 10_000) / 1.2 / 1000) * 1000;
    expect(windowDerived1m).toBe(825_000);
    expect(selfSetCeilingForSpec('opus[1m]')).toBe(825_000);
    expect(selfSetCeilingForSpec('opus[1m]:xhigh')).toBe(825_000);
    // an UNRESOLVABLE spec is a 1M session on this fleet (WI-3383), so it gets the same
    expect(selfSetCeilingForSpec(null)).toBe(825_000);
    expect(selfSetCeilingForSpec('')).toBe(825_000);
    expect(clampCompactionLimit(900_000, 'opus[1m]', { selfSet: true })).toBe(825_000);
    expect(clampCompactionLimit(700_000, 'opus[1m]', { selfSet: true })).toBe(700_000);
  });

  // CONTROL: the whole point is that SEEDING is unchanged, so the fleet-wide cost
  // profile behind the 2026-07-03 400k directive is untouched. If this ever goes red,
  // the change leaked from the self-set path into the default and every session got
  // more expensive.
  it('the SEEDED default is untouched — still 400k, and a non-selfSet clamp still caps there', () => {
    expect(defaultCompactionLimitForSpec('opus[1m]')).toBe(400_000);
    expect(clampCompactionLimit(900_000, 'opus[1m]')).toBe(400_000);
    expect(clampCompactionLimit(900_000, 'opus[1m]', { selfSet: false })).toBe(400_000);
  });

  it('fleet MEMBERS cannot self-raise past their 250k role cap — selfSet does not beat role', () => {
    expect(selfSetCeilingForSpec('opus[1m]', { fleetMember: true })).toBe(250_000);
    expect(clampCompactionLimit(900_000, 'opus[1m]', { fleetMember: true, selfSet: true })).toBe(250_000);
  });

  it('a real small-window spec is unaffected — self-set still derives from ITS window', () => {
    expect(selfSetCeilingForSpec('haiku')).toBe(158_000);
    expect(clampCompactionLimit(900_000, 'haiku', { selfSet: true })).toBe(158_000);
  });

  it('the MIN floor still applies on the self-set path', () => {
    expect(clampCompactionLimit(1, 'opus[1m]', { selfSet: true })).toBe(MIN_COMPACTION_LIMIT_TOKENS);
  });
});

describe('defaultCompactionLimitForSpec (keys on the [1m] MARKER only)', () => {
  it('[1m] specs are capped at 400k (preemptive compaction despite the 1M window)', () => {
    expect(COMPACTION_LIMIT_DEFAULT_1M_CAP).toBe(400_000);
    expect(defaultCompactionLimitForSpec('opus[1m]')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('opus[1m]:xhigh')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('claude-fable-5[1m]:xhigh')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('sonnet[1m]:medium')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('haiku[1m]')).toBe(400_000);
  });
  it('[1m] fleet MEMBERS default to the leaner 250k (owner 2026-09-02, up from 200k); role never touches a real-window derivation', () => {
    expect(COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP).toBe(250_000);
    expect(defaultCompactionLimitForSpec('sonnet[1m]:high', { fleetMember: true })).toBe(250_000);
    expect(defaultCompactionLimitForSpec('opus[1m]', { fleetMember: true })).toBe(250_000);
    // explicit non-member (leader/solo) keeps the full cap
    expect(defaultCompactionLimitForSpec('sonnet[1m]:high', { fleetMember: false })).toBe(400_000);
    // a 200k-window member still derives from the REAL window, not the role
    expect(defaultCompactionLimitForSpec('haiku', { fleetMember: true })).toBe(158_000);
  });
  it("a BARE default-1M-family spec derives 158k — BELOW CC's own ~167k auto trigger on the real 200k window, so papercusp compacts cleanly first", () => {
    expect(defaultCompactionLimitForSpec('opus')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-5:high')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('sonnet:medium')).toBe(158_000);
  });
  it('a 200k-window spec derives 158k', () => {
    // floor((200_000 - 10_000) / 1.2 / 1000) * 1000 = 158_000
    expect(defaultCompactionLimitForSpec('haiku')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('claude-sonnet-4-6')).toBe(158_000);
  });
  it('an UNRESOLVABLE spec (null / empty) seeds the [1m] policy default, NOT 158k (WI-3383, owner 2026-07-08)', () => {
    // On this opus[1m]-default fleet a truly-unknown spec is an opus[1m] session:
    // seed 400k (200k member), never the haiku-sized 158k that mis-seeded a
    // manually-launched su session. Only null/empty lifts — a NON-null bare
    // `opus`/`sonnet` still derives 158k (asserted above).
    expect(defaultCompactionLimitForSpec(null)).toBe(400_000);
    expect(defaultCompactionLimitForSpec(undefined)).toBe(400_000);
    expect(defaultCompactionLimitForSpec('')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('   ')).toBe(400_000);
    expect(defaultCompactionLimitForSpec(null, { fleetMember: true })).toBe(250_000);
    expect(defaultCompactionLimitForSpec('', { fleetMember: true })).toBe(250_000);
  });
});

describe('defaultCompactionLimitForWindow (live backend window)', () => {
  it('clamps Codex gpt-5.6 effective 258400 window to a 207k leader soft limit', () => {
    expect(defaultCompactionLimitForWindow(258_400)).toBe(207_000);
  });

  it('un-pins a Codex fleet member to its OWN 207k window derivation once the role cap rises above it', () => {
    // The role cap only binds when it is LOWER than the window derivation. At the
    // former 200k cap this member was held at 200_000; at the 250k cap (owner
    // 2026-09-02) the 258_400 window's own (258_400 - 10_000) / 1.2 derivation wins.
    expect(defaultCompactionLimitForWindow(258_400, { fleetMember: true })).toBe(207_000);
  });

  it('preserves the established 1M and 200k derivations', () => {
    expect(defaultCompactionLimitForWindow(1_000_000)).toBe(400_000);
    expect(defaultCompactionLimitForWindow(200_000)).toBe(158_000);
  });
});

describe('selfSetCeilingForWindow (measured runtime override ceiling)', () => {
  it('allows a leader/solo override above the 400k seeded cap when the window supports it', () => {
    expect(selfSetCeilingForWindow(828_400)).toBe(682_000);
  });

  it('keeps fleet members at their role ceiling even with a wider measured window', () => {
    expect(selfSetCeilingForWindow(828_400, { fleetMember: true })).toBe(COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP);
  });

  it('honors the minimum for an invalid or tiny measurement', () => {
    expect(selfSetCeilingForWindow(1)).toBe(MIN_COMPACTION_LIMIT_TOKENS);
  });
});

/**
 * plan codex-1m-context-window-2026-08-17 D-001. Papercusp's soft limits are
 * UNCHANGED — these assert that a Codex session can now REACH them. Before this,
 * `modelWindowForSpec` recognised only Claude's `[1m]` marker, so every codex
 * spec fell to a fabricated 200k window and seeded 158,000: an su on gpt-5.6
 * compacted at well under half the runway the 400k policy grants it.
 */
describe('codex extended-window specs seed the SAME role caps as claude [1m]', () => {
  it('seeds 400k for an ad-hoc su / fleet leader', () => {
    for (const spec of ['gpt-5.6-sol', 'gpt-5.6-sol:high', 'gpt-5.6-terra:xhigh', 'sol', 'luna:max', 'gpt-5.4']) {
      expect(defaultCompactionLimitForSpec(spec), spec).toBe(400_000);
    }
  });

  it('seeds 250k for a fleet member', () => {
    for (const spec of ['gpt-5.6-sol:high', 'terra', 'gpt-5.4']) {
      expect(defaultCompactionLimitForSpec(spec, { fleetMember: true }), spec).toBe(250_000);
    }
  });

  it('leaves NON-extended codex models on the conservative 158k derivation', () => {
    // These report max_context_window == context_window, so they really do run a
    // small window and a 400k seed would mean papercusp never pre-empts. Note
    // gpt-5.4 IS extended while gpt-5.4-mini is NOT — a substring test would get
    // this exact pair wrong.
    for (const spec of ['gpt-5.5', 'gpt-5.5:high', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(defaultCompactionLimitForSpec(spec), spec).toBe(158_000);
    }
  });

  it('does not disturb the claude derivations it shares a resolver with', () => {
    expect(defaultCompactionLimitForSpec('opus[1m]')).toBe(400_000);
    expect(defaultCompactionLimitForSpec('haiku')).toBe(158_000);
    expect(defaultCompactionLimitForSpec('sonnet')).toBe(158_000);
  });
});

describe('supersededDerivedCompactionLimits reaches stranded claude [1m] fleet members (EI-22241751831038573)', () => {
  // The watchdog's upward heal fires only when a stored limit equals the CURRENT
  // derived seed or one of these. Measured 2026-09-03: a fleet member pinned at
  // 200_000 against a true 1M window (cap since moved to 250_000) was unraisable,
  // so every carry-respawn successor re-crossed the limit within ~8 minutes — 15
  // consecutive sessions. The codex branch had the identical bug and its fix was
  // scoped to codex, leaving claude bare.
  const stored = 200_000;

  it('lists the outgoing fleet-member cap so a stranded session is recognised as DERIVED', () => {
    for (const spec of ['claude-opus-5[1m]', 'opus[1m]', 'sonnet[1m]']) {
      const superseded = supersededDerivedCompactionLimits(spec, { fleetMember: true });
      expect(superseded).toContain(stored);
      // and the heal predicate the watchdog actually evaluates now passes
      const seed = defaultCompactionLimitForSpec(spec, { fleetMember: true });
      expect(seed === stored || superseded.includes(stored)).toBe(true);
    }
  });

  it('still raises TOWARD the policy cap, never past it', () => {
    expect(defaultCompactionLimitForSpec('opus[1m]', { fleetMember: true })).toBe(
      COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
    );
  });

  it('never reports the CURRENT derivation as superseded', () => {
    for (const spec of ['claude-opus-5[1m]', 'opus[1m]', null]) {
      const current = defaultCompactionLimitForSpec(spec, { fleetMember: true });
      expect(supersededDerivedCompactionLimits(spec, { fleetMember: true })).not.toContain(current);
    }
  });

  it('does NOT widen non-1m specs or non-fleet-members (the fix stays scoped)', () => {
    expect(supersededDerivedCompactionLimits('claude-opus-5', { fleetMember: true })).toEqual([]);
    // a leader/solo keeps its own cap history, which these values are not part of
    expect(supersededDerivedCompactionLimits('opus[1m]', { fleetMember: false })).toEqual([]);
  });

  it('derivesFrom1mWindow is the SHORT-CIRCUIT branch, not "resolves to a 1M window"', () => {
    // The marker/blank short-circuit implies a 1M derivation...
    for (const spec of ['opus[1m]', 'claude-opus-5[1m]', null, '', '   ']) {
      expect(derivesFrom1mWindow(spec)).toBe(true);
      expect(defaultCompactionLimitForSpec(spec, { fleetMember: false })).toBe(
        defaultCompactionLimitForWindow(MODEL_WINDOW_1M, { fleetMember: false }),
      );
    }
    // ...but NOT conversely: a bare gpt-5.6-luna:high carries no [1m] marker and
    // still resolves to a 1M window via modelWindowForSpec. Keying the superseded
    // list on this helper would have excluded that whole backend, which is why the
    // list keys on the DERIVED SEED instead.
    expect(derivesFrom1mWindow('gpt-5.6-luna:high')).toBe(false);
    expect(modelWindowForSpec('gpt-5.6-luna:high')).toBe(MODEL_WINDOW_1M);
  });

  it('covers a markerless spec that still derives the 1M fleet-member cap', () => {
    expect(defaultCompactionLimitForSpec('gpt-5.6-luna:high', { fleetMember: true })).toBe(
      COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
    );
    expect(supersededDerivedCompactionLimits('gpt-5.6-luna:high', { fleetMember: true })).toContain(stored);
  });

  it('every superseded cap is below the current one (they are OUTGOING values)', () => {
    for (const cap of SUPERSEDED_1M_FLEET_MEMBER_CAPS) {
      expect(cap).not.toBe(COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP);
    }
  });
});

describe('clampCompactionLimit (the default is also the CEILING)', () => {
  it('clamps a [1m] request above 400k down to the 400k cap', () => {
    expect(clampCompactionLimit(900_000, 'opus[1m]')).toBe(400_000);
    expect(clampCompactionLimit(600_000, 'claude-fable-5[1m]:xhigh')).toBe(400_000);
  });
  it('the CEILING for an explicit set stays the spec cap (400k) even for a fleet member — 300k shapes only the DEFAULT', () => {
    // clampCompactionLimit takes no role: an explicit 350k on a member is honored.
    expect(clampCompactionLimit(350_000, 'sonnet[1m]:high')).toBe(350_000);
  });
  it('honors a leaner [1m] request below the cap', () => {
    expect(clampCompactionLimit(120_000, 'opus[1m]')).toBe(120_000);
  });
  it('clamps a bare-family request to the 158k derived ceiling (the real 200k window)', () => {
    expect(clampCompactionLimit(500_000, 'sonnet:medium')).toBe(158_000);
  });
  it('an unresolvable spec (null) clamps to the 400k [1m] ceiling now, not 158k (WI-3383)', () => {
    // config:set-compaction-limit on a session whose spec did not resolve is no
    // longer forced down to 158k — the fleet default is opus[1m], so 400k holds.
    expect(clampCompactionLimit(400_000, null)).toBe(400_000);
    expect(clampCompactionLimit(900_000, null)).toBe(400_000);
    expect(clampCompactionLimit(250_000, null)).toBe(250_000);
  });
  it('floors any request at MIN_COMPACTION_LIMIT_TOKENS', () => {
    expect(clampCompactionLimit(1_000, 'opus[1m]')).toBe(MIN_COMPACTION_LIMIT_TOKENS);
  });

  // per-member-declarative-launch-specs P-005: a fleet MEMBER is governed by the
  // leaner member ceiling, so an explicit request (psu --compaction-limit, or its
  // own config:set-compaction-limit) must not buy it a leader's headroom.
  it('applies the fleet-member ceiling when the requester is known to be a member', () => {
    expect(clampCompactionLimit(400_000, 'opus[1m]', { fleetMember: true })).toBe(
      COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
    );
    expect(clampCompactionLimit(900_000, null, { fleetMember: true })).toBe(
      COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
    );
  });

  it('lets a member lower its limit freely — the cap is a ceiling, not a target', () => {
    expect(clampCompactionLimit(120_000, 'opus[1m]', { fleetMember: true })).toBe(120_000);
  });

  it('omitting opts keeps the pre-existing leader/solo ceiling (no caller behavior change)', () => {
    expect(clampCompactionLimit(400_000, 'opus[1m]')).toBe(COMPACTION_LIMIT_DEFAULT_1M_CAP);
  });
});

// The TS twin of psu-launcher `validateModelSpec` (WI-1979 / WI-1993). Same vector
// table the launcher's own suite pins — a divergence here (or there) is caught by
// the parity test in apps/operator/lib/psu-launcher.test.ts, which asserts the two
// functions agree value-for-value. This suite pins the CONTRACT (what passes / what
// the corrective message says) independently of that cross-package guard.
describe('validateCloudModelSpec (tool-boundary cloud model-spec guard — WI-1993)', () => {
  it('KNOWN_CLOUD_ALIASES is the canonical short-alias set (Anthropic + OpenAI GPT-5.6)', () => {
    expect([...KNOWN_CLOUD_ALIASES]).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'sol', 'terra', 'luna']);
  });
  it('accepts valid aliases, effort specs, full/provider ids, [1m] round-trips, local ids, and empty', () => {
    for (const s of [
      'fable:xhigh',
      'opus:max',
      'sonnet',
      'sonnet:high',
      'haiku',
      'opus[1m]:max',
      'sonnet[1m]',
      'claude-fable-5:xhigh',
      'claude-fable-5[1m]',
      'claude-sonnet-5:high',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'sol',
      'sol:high',
      'sol:max',
      'terra:xhigh',
      'luna',
      'luna:medium',
      'gpt-5.6-sol',
      'gpt-5.6-terra:high',
      'gpt-5.6-luna:xhigh',
      'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
      'gpt-5-codex',
      '',
    ]) {
      expect(validateCloudModelSpec(s).ok, s).toBe(true);
    }
    expect(validateCloudModelSpec(null).ok).toBe(true);
    expect(validateCloudModelSpec(undefined).ok).toBe(true);
  });
  it('accepts an unknown-but-plausible short id that is NOT a close typo (o3 / gpt4 / grok)', () => {
    for (const s of ['o3', 'gpt4', 'grok']) expect(validateCloudModelSpec(s).ok, s).toBe(true);
  });
  it('rejects a hand-typed [1m] marker on a non-family base (the fabel5[1m] incident), with the marker tip + suggestion', () => {
    const r = validateCloudModelSpec('fabel5[1m]');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('do not type it');
    expect(r.message).toContain('fable');
  });
  it('rejects a close-typo alias — incl. transpositions — with a "did you mean" suggestion', () => {
    for (const [bad, want] of [
      ['fabel', 'fable'],
      ['sonet', 'sonnet'],
      ['sonnet5', 'sonnet'],
      ['opus4', 'opus'],
      ['opuss', 'opus'],
      ['fabel5:xhigh', 'fable'],
    ] as const) {
      const r = validateCloudModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
  it('rejects version-suffixed GPT-5.6 aliases (sol-5.6, terra-5, luna-5.6) and suggests the bare alias', () => {
    for (const [bad, want] of [
      ['sol-5.6', 'sol'],
      ['terra-5', 'terra'],
      ['luna-5.6', 'luna'],
      ['sol-5.6:high', 'sol:high'],
      ['terra-5:xhigh', 'terra:xhigh'],
    ] as const) {
      const r = validateCloudModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
      expect(r.message, bad).toContain('gpt-5.6-');
    }
  });
});

// EI-12657 recurrence guard: every COMMITTED per-role model default must be a
// spec the launcher/gateway can actually run. The 2026-07-15 model-switch pinned
// the autonomous roles to the VERSIONED shorthand `sonnet-5[1m]:high` — which
// `validateModelSpec` rejects (`sonnet-5` is not an alias) and the gateway forwards
// verbatim as an unrunnable upstream id — so EVERY Mug/queen/bee/kettle/... spawn
// died before its first LLM turn (total placement stall). validateCloudModelSpec is
// the TS twin of the psu-launcher gate the spawn actually passes through, so pinning
// EVERY ROLE_MODEL_DEFAULTS spec against it would have caught the malformed default
// at the gate instead of via a fleet-wide outage.
describe('ROLE_MODEL_DEFAULTS — every committed spec is a launcher-valid model spec (EI-12657)', () => {
  it('accepts no versioned-shorthand / otherwise-unrunnable default (e.g. sonnet-5[1m]:high)', () => {
    for (const [role, spec] of Object.entries(ROLE_MODEL_DEFAULTS)) {
      const r = validateCloudModelSpec(spec);
      expect(r.ok, `${role} → "${spec}": ${r.message ?? ''}`).toBe(true);
    }
  });
});

describe('PUBLIC_PORTAL_AGENT_BASELINE (papercup-chat public release P-005)', () => {
  it('pins the public surface to the Papercup role floor and its compatible backend', () => {
    expect(PUBLIC_PORTAL_AGENT_BASELINE).toEqual({
      model: ROLE_MODEL_DEFAULTS.papercup,
      backend: 'claude-code',
    });
    expect(validateCloudModelSpec(PUBLIC_PORTAL_AGENT_BASELINE.model).ok).toBe(true);
  });
});
