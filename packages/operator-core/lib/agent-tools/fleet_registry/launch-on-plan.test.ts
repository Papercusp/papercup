/**
 * launch-on-plan.test.ts — WI-1408 (fleet-registration-persists): the
 * `fleet:launch-on-plan` path builds every member's `psu` invocation via
 * `memberLaunchCommand`. The Queen's brief called this out as one of the TWO
 * launch paths that must thread `--fleet` all the way to registration (the
 * other being a direct `psu --fleet=<slug>` member launch, covered by
 * apps/operator/lib/psu-launcher.test.ts + bootstrap-su/-role's own WI-1408
 * suites). This pins the pure, PG-free half of that contract: the command
 * string a member actually execs always carries `--fleet=<slug>` — the flag
 * bootstrap-su/-role's `resolveFleet` + presence.ts's pending-fleet bridge
 * need to persist a non-null fleetSlug onto the member's presence row (and
 * therefore group it under the fleet in fleet:assignments, per
 * packages/operator-core/lib/fleet/assignments.ts's `groupByAgent`).
 */
import { describe, it, expect } from 'vitest';
import launchOnPlan, {
  memberLaunchCommand,
  isOmpLocalModel,
  resolveFleetAgent,
  buildFleetKindClaimSpec,
  clampFleetTopUpToCapacity,
  composeMemberLaunchContext,
  renderMemberBaseline,
  type MemberLaunchOpts,
} from './launch-on-plan';

const base: MemberLaunchOpts = {
  fleetSlug: 'atlas-fleet',
  agent: 'claude',
  harness: 'papercup',
  plan: 'p-plan',
};

describe('memberLaunchCommand (WI-1408 — fleet:launch-on-plan threads --fleet into the member launch)', () => {
  it('always includes --fleet=<slug> — never a colour-only, unfleeted member launch', () => {
    const cmd = memberLaunchCommand(base);
    expect(cmd).toMatch(/(^|\s)--fleet=atlas-fleet(\s|$)/);
  });

  it('the flag carries the REAL fleet slug (not the display name) even with a fancy fleet name-derived slug', () => {
    const cmd = memberLaunchCommand({ ...base, fleetSlug: 'my-new-fleet' });
    expect(cmd).toContain('--fleet=my-new-fleet');
  });

  it('--fleet is present alongside the other required tokens (--no-picker, agent/harness/plan) — parity with a direct member launch', () => {
    const cmd = memberLaunchCommand(base);
    const tokens = cmd.split(' ');
    expect(tokens[0]).toBe('psu');
    expect(tokens).toContain('--no-picker');
    expect(tokens).toContain('--fleet=atlas-fleet');
    expect(tokens).toContain('--agent=claude');
    expect(tokens).toContain('--harness=papercup');
    expect(tokens).toContain('--plan=p-plan');
  });

  it('optional flags (role/account/model/...) never crowd out or duplicate --fleet', () => {
    const cmd = memberLaunchCommand({
      ...base,
      account: 'acct-1',
      role: 'worker',
      model: 'opus:high',
      feature: 'F-001',
      contextSize: 'trimmed',
      brain: true,
    });
    const fleetOccurrences = cmd.match(/--fleet=/g) ?? [];
    expect(fleetOccurrences).toHaveLength(1);
    expect(cmd).toContain('--fleet=atlas-fleet');
  });

  it('allowSubagents (owner mandate 2026-07-02): omitted by default (deny), --allow-subagents when opted in', () => {
    expect(memberLaunchCommand(base)).not.toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: true }).split(' ')).toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: false })).not.toContain('--allow-subagents');
  });

  // P-003 headless fleet: `--headless` forces the managed-pty host on despite non-TTY stdio so
  // the member (no window) stays injectable for warm wakes. Boolean flag like --brain.
  it('headless (P-003): omitted by default (visible), --headless when opted in — and never crowds out --fleet', () => {
    expect(memberLaunchCommand(base)).not.toContain('--headless');
    const cmd = memberLaunchCommand({ ...base, headless: true });
    const tokens = cmd.split(' ');
    expect(tokens).toContain('--headless');
    expect(tokens).toContain('--fleet=atlas-fleet');
    expect(tokens).toContain('--no-picker');
    expect(memberLaunchCommand({ ...base, headless: false })).not.toContain('--headless');
    // exactly one occurrence, coexists with other optional flags
    const both = memberLaunchCommand({ ...base, headless: true, account: 'acct-1', model: 'opus:high' });
    expect((both.match(/--headless/g) ?? [])).toHaveLength(1);
  });
});

// P-004 carry (owner directive 2026-07-10, INDEPENDENT of headless): the warm/cold auto-mode
// knob threads into the member operating baseline. renderMemberBaseline / composeMemberLaunchContext
// rewrite the loop:arm rule + promote the checkpoint to load-bearing for a COLD member; warm
// (default) is byte-identical to before so nothing silently goes cold.
describe('member baseline carry directive (P-004 — warm/cold auto-mode)', () => {
  const opts = { fleetSlug: 'atlas-fleet', plan: 'p-plan', count: 3 };

  it('WARM (default): arms a plain loop:arm and never mentions cold carry', () => {
    const warm = renderMemberBaseline(opts);
    expect(warm).toContain('`loop:arm { intervalSec, goal }`');
    expect(warm).not.toContain("carry: 'cold'");
    expect(warm).not.toContain('COLD');
    // explicit warm is identical to the default
    expect(renderMemberBaseline({ ...opts, carry: 'warm' })).toBe(warm);
  });

  it('COLD: rewrites the loop:arm rule to arm a cold loop and marks the checkpoint load-bearing', () => {
    const cold = renderMemberBaseline({ ...opts, carry: 'cold' });
    expect(cold).toContain("`loop:arm { intervalSec, goal, carry: 'cold' }`");
    expect(cold).not.toContain('`loop:arm { intervalSec, goal }`'); // the warm form is gone
    expect(cold).toMatch(/COLD CARRY makes this LOAD-BEARING/);
    // the STAY ALIVE rule explains a cold wake starts fresh
    expect(cold).toMatch(/FRESH context/);
  });

  it('composeMemberLaunchContext threads carry through to the baseline (warm vs cold)', () => {
    const warm = composeMemberLaunchContext({ ...opts, carry: 'warm' });
    const cold = composeMemberLaunchContext({ ...opts, carry: 'cold' });
    expect(warm).not.toContain("carry: 'cold'");
    expect(cold).toContain("carry: 'cold'");
    // carry does not disturb the leader's per-fleet brief, which still layers below
    const coldWithBrief = composeMemberLaunchContext({ ...opts, carry: 'cold', customBriefText: 'FLEET SPECIAL BRIEF' });
    expect(coldWithBrief).toContain('FLEET SPECIAL BRIEF');
    expect(coldWithBrief).toContain("carry: 'cold'");
  });
});

// P-003/P-004 arg-schema round-trip: both knobs parse, default undefined (→ visible + warm
// downstream), reject bad values, and are optional.
describe('headless + carry args (P-003/P-004)', () => {
  const parseArgs = (extra: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => Record<string, unknown> }).parse({
      name: 'atlas',
      plan: 'p-plan',
      ...extra,
    });

  it('headless: accepts booleans, rejects non-boolean, optional (default undefined)', () => {
    expect(parseArgs({ headless: true }).headless).toBe(true);
    expect(parseArgs({ headless: false }).headless).toBe(false);
    expect(parseArgs({}).headless).toBeUndefined();
    expect(() => parseArgs({ headless: 'yes' })).toThrow();
  });

  it("carry: accepts 'warm'/'cold', rejects other strings, optional (default undefined)", () => {
    expect(parseArgs({ carry: 'warm' }).carry).toBe('warm');
    expect(parseArgs({ carry: 'cold' }).carry).toBe('cold');
    expect(parseArgs({}).carry).toBeUndefined();
    expect(() => parseArgs({ carry: 'lukewarm' })).toThrow();
  });

  it('headless and carry are INDEPENDENT — every combination parses', () => {
    for (const headless of [true, false]) {
      for (const carry of ['warm', 'cold']) {
        expect(() => parseArgs({ headless, carry }), `${headless}/${carry}`).not.toThrow();
      }
    }
  });
});

describe('isOmpLocalModel (agent/model coupling — "thought ornith, got claude" guard, 2026-07-03)', () => {
  it('flags local/gateway models that ONLY the omp backend can run', () => {
    expect(isOmpLocalModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true); // the exact id the leader passed
    expect(isOmpLocalModel('ollama/llama3')).toBe(true);
    expect(isOmpLocalModel('ornith:35b')).toBe(true);
    expect(isOmpLocalModel('ornith:fast')).toBe(true);
    expect(isOmpLocalModel('  ollama-cc/x ')).toBe(true); // tolerant of surrounding space
  });

  it('does NOT flag claude/codex model ids (they stay on their default backend)', () => {
    expect(isOmpLocalModel('opus:high')).toBe(false);
    expect(isOmpLocalModel('opus[1m]')).toBe(false);
    expect(isOmpLocalModel('claude-sonnet-4-6')).toBe(false);
    expect(isOmpLocalModel('gpt-4o')).toBe(false);
    expect(isOmpLocalModel(undefined)).toBe(false);
    expect(isOmpLocalModel('')).toBe(false);
  });
});

describe('resolveFleetAgent (backend + model inheritance — fleet-launch-agent-inheritance-2026-07-03)', () => {
  it('an explicit `agent` arg wins over an inferred/inherited backend', () => {
    expect(resolveFleetAgent({ argAgent: 'claude' })).toEqual({ agent: 'claude', model: undefined });
    expect(resolveFleetAgent({ argAgent: 'codex', callerAgent: 'omp', callerModel: 'ollama-cc/x' })).toEqual({
      agent: 'codex',
      model: undefined,
    });
  });

  it('infers omp from a local/ollama model when no agent is given (and keeps that model)', () => {
    expect(resolveFleetAgent({ argModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' })).toEqual({
      agent: 'omp',
      model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    });
  });

  it('inherits the CALLER backend when neither agent nor a local model is given (the claude-leak fix)', () => {
    expect(resolveFleetAgent({ callerAgent: 'omp' })).toEqual({ agent: 'omp', model: undefined });
  });

  it('inherits the caller MODEL too when the backend is inherited (ornith leader → ornith members)', () => {
    expect(
      resolveFleetAgent({ callerAgent: 'omp', callerModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' }),
    ).toEqual({ agent: 'omp', model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' });
  });

  it('falls back to claude only when nothing is known (or the caller backend is unrecognized)', () => {
    expect(resolveFleetAgent({})).toEqual({ agent: 'claude', model: undefined });
    expect(resolveFleetAgent({ callerAgent: 'not-a-backend', callerModel: 'x' })).toEqual({
      agent: 'claude',
      model: undefined,
    });
  });

  it('does NOT bleed the caller model onto a member whose backend was pinned explicitly', () => {
    // explicit agent=omp, caller was claude+opus → member is omp with NO claude model
    expect(resolveFleetAgent({ argAgent: 'omp', callerAgent: 'claude', callerModel: 'opus:high' })).toEqual({
      agent: 'omp',
      model: undefined,
    });
  });

  it('an explicit `model` arg always wins over an inherited caller model', () => {
    expect(
      resolveFleetAgent({ callerAgent: 'omp', callerModel: 'ollama-cc/a', argModel: 'ollama-cc/b' }),
    ).toEqual({ agent: 'omp', model: 'ollama-cc/b' });
  });

  it('rejects an explicit claude/codex + local-model pairing (the thought-ornith-got-claude trap)', () => {
    const r = resolveFleetAgent({ argAgent: 'claude', argModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' });
    expect('error' in r).toBe(true);
    expect('error' in r && r.error).toMatch(/only the `omp` backend can run/);
  });
});

// The P-005 idempotency guard moved to PG (agent_fleets.last_launch_at, migration 484) so it
// holds across the multi-process :3070 worker pool — semantics are covered by
// agent-fleets-store.integration.test.ts (claimFleetLaunchSlot / releaseFleetLaunchSlot).

// WI-1993: the `model` arg rejects a malformed CLOUD spec at the TOOL BOUNDARY (before opening
// any desktop windows), not just per-member at psu boot. Exercises the real zod schema via
// `.args.parse` — the fuzzyEnum(local) leg fails open (empty local registry in the test env),
// so this isolates the chained validateCloudModelSpec superRefine.
describe('model arg — cloud model-spec validation at the tool boundary (WI-1993)', () => {
  const parseModel = (model: string) =>
    (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse({ name: 'atlas', plan: 'p-plan', model });
  it('rejects a hand-typed [1m] marker on a non-family alias (the fabel5[1m] incident)', () => {
    expect(() => parseModel('fabel5[1m]')).toThrow(/fable/);
  });
  it('rejects a close-typo alias with a corrective suggestion', () => {
    expect(() => parseModel('opuss')).toThrow(/opus/);
    expect(() => parseModel('sonet')).toThrow(/sonnet/);
  });
  it('accepts valid cloud specs, full ids, plausible-unknown short ids, and local ornith ids', () => {
    for (const m of [
      'opus:high', 'fable:xhigh', 'sonnet', 'haiku', 'opus[1m]:max', 'claude-fable-5',
      'o3', 'gpt4', 'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    ]) {
      expect(() => parseModel(m), m).not.toThrow();
    }
  });
});

// EI-7671: fleet:launch-on-plan previously never set an initial claim spec, so members
// booted and self-pulled via scheduler:get_next under the empty-filter DEFAULT_CLAIM_SPEC
// (admits every kind, including feature/chunk) before the leader got around to calling
// scheduler:set_claim_spec by hand — a drain fleet told "bugs only" could still grab
// feature-family work in that boot-race window. buildFleetKindClaimSpec is the pure spec
// builder the handler now calls BEFORE opening any member terminal.
describe('buildFleetKindClaimSpec (EI-7671 — fleet-level kind-filter claim spec)', () => {
  it('builds a valid-shaped spec restricting to the given kinds', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug', 'change', 'task']);
    expect(spec).toMatchObject({
      specVersion: '1.0',
      revision: 1,
      view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] } },
    });
    expect(typeof spec.specId).toBe('string');
    expect((spec.specId as string).length).toBeGreaterThan(0);
  });

  it('names the fleet in specId so specs for different fleets never collide', () => {
    const a = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    const b = buildFleetKindClaimSpec('other-fleet', ['bug']);
    expect(a.specId).not.toBe(b.specId);
  });

  it('copies the kinds array (mutating the input after the call does not affect the spec)', () => {
    const kinds = ['bug', 'change'];
    const spec = buildFleetKindClaimSpec('atlas-fleet', kinds);
    kinds.push('feature');
    expect((spec.view as { filter: { value: string[] } }).filter.value).toEqual(['bug', 'change']);
  });

  it('inherits rank + limits unchanged (only view.filter narrows, per D-002)', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    expect(spec.rank).toBeTruthy();
    expect(spec.limits).toBeTruthy();
  });
});

describe('claimKinds arg (EI-7671)', () => {
  const parse = (claimKinds: unknown) =>
    (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse({ name: 'atlas', plan: 'p-plan', claimKinds });

  it('accepts a valid kind list', () => {
    expect(() => parse(['bug', 'change', 'task'])).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => parse(['bogus'])).toThrow();
  });

  it('rejects an empty array (min 1)', () => {
    expect(() => parse([])).toThrow();
  });

  it('is optional — omitting it entirely still parses', () => {
    expect(() =>
      (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse({ name: 'atlas', plan: 'p-plan' }),
    ).not.toThrow();
  });
});

// EI-8807: fleet:launch-on-plan's owner-override for the capacity clamp. Two concurrent fixes each
// added `overrideCapacityClamp`, producing a duplicate object-literal key (TS1117 + a describe that
// referenced a nonexistent `capacityClampOverridden` result field). These lock in the arg's single
// canonical shape AND the override's behavior so neither the arg nor the escape hatch can silently
// regress. `clampFleetTopUpToCapacity` is the pure capacity-clamp authority the tool calls.
describe('overrideCapacityClamp arg + clamp override (EI-8807)', () => {
  const parseArgs = (extra: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => Record<string, unknown> }).parse({
      name: 'atlas',
      plan: 'p-plan',
      ...extra,
    });

  it('accepts overrideCapacityClamp:true and surfaces it (single, non-dropped key)', () => {
    // A duplicate object-literal key would keep only the last describe; a dropped/renamed key would
    // strip the value on parse. Assert the boolean survives a round-trip through the args schema.
    expect(parseArgs({ overrideCapacityClamp: true }).overrideCapacityClamp).toBe(true);
    expect(parseArgs({ overrideCapacityClamp: false }).overrideCapacityClamp).toBe(false);
  });

  it('is optional — omitting it still parses (default off downstream)', () => {
    expect(() => parseArgs({})).not.toThrow();
    expect(parseArgs({}).overrideCapacityClamp).toBeUndefined();
  });

  it('rejects a non-boolean overrideCapacityClamp', () => {
    expect(() => parseArgs({ overrideCapacityClamp: 'yes' })).toThrow();
  });

  // The core EI-8807 incident: a gateway-routed launch with a pool reading healthyAccounts:0 was
  // clamped to ZERO despite a full dispatchBudget, and there was no way for an owner to override it.
  const walledPool = { reachable: true, healthyAccounts: 0, dispatchBudget: 13, recommendedHeadroom: 8 };

  it('WITHOUT override: a gateway-routed healthyAccounts:0 pool still suppresses the top-up to 0', () => {
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: true });
    expect(clamp).not.toBeNull();
    expect(clamp!.openCount).toBe(0);
    expect(clamp!.clamped).toBe(true);
    expect(clamp!.overridden).toBe(false);
    // The recommendation is legible independent of application.
    expect(clamp!.recommendedOpenCount).toBe(0);
  });

  it('WITH override: launches ALL requested members even at healthyAccounts:0, and reports the override', () => {
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: true, override: true });
    expect(clamp).not.toBeNull();
    expect(clamp!.openCount).toBe(4); // owner override defeats the zero-gate
    expect(clamp!.overridden).toBe(true);
    // The recommendation is still COMPUTED + reported — the override is never invisible.
    expect(clamp!.recommendedOpenCount).toBe(0);
    expect(clamp!.reason).toMatch(/OVERRIDDEN/);
  });

  it('a DIRECT-credential member is not gated by pool health at all (no override needed)', () => {
    // fleet-launch-zero-gate-routing-blind: a member on the direct system credential never asks the
    // gateway to authenticate, so an exhausted pool must not suppress it. dispatchBudget is the cap.
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: false });
    expect(clamp!.openCount).toBe(4);
    expect(clamp!.clamped).toBe(false);
    expect(clamp!.overridden).toBe(false);
  });
});
