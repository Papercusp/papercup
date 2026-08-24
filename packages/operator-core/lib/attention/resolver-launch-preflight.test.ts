/**
 * RESOLVER LAUNCH PREFLIGHT (bulk-resolver-controls-and-run-lifecycle-2026-08-24,
 * P-004). Three things are pinned here:
 *
 *  1. THE TWO VALIDATORS ANSWER DIFFERENT QUESTIONS. `bulkResolverLaunchProfilesProblem`
 *     guards the stored CONFIG DOCUMENT (per-field syntax);
 *     `resolveBulkResolverLaunch` guards the LAUNCH (model/backend/account
 *     compatibility). The whole justification for a second function is that a
 *     profile can pass the first and still be unlaunchable — so that gap is
 *     pinned by example below. If a future edit makes the document validator
 *     subsume this one, the `documentAcceptsWhatLaunchRefuses` case fails and
 *     forces the question to be re-answered rather than silently collapsing
 *     into a duplicate (D-001: no parallel implementation).
 *
 *  2. PREFLIGHT RUNS BEFORE RUN CREATION. `buildAgentLaunchCommand` composes the
 *     model spec through `composeModelSpec`, which THROWS on an impossible
 *     combination. That throw lands inside the launcher's catch, which records a
 *     run that was created and then immediately failed. Every combination this
 *     validator refuses is therefore a combination that would otherwise become a
 *     failed run row instead of a 400 — the `refusesEveryComboThatWouldThrow`
 *     case pins exactly that correspondence.
 *
 *  3. AN OLDER CLIENT STILL LAUNCHES. A body with no `launch` key must produce
 *     byte-identical behavior to the pre-configuration route.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUD_MODEL_MENU,
  composeLaunchModelSpec,
  resolveBulkResolverLaunch,
} from '../agent-config-constants';
import { bulkResolverLaunchProfilesProblem } from '../agent-config';
import {
  buildResolverLaunchCommand,
  preflightResolverLaunch,
} from '../endpoint-route/routes/admin/attention-bulk-resolve';

describe('resolveBulkResolverLaunch — defaults', () => {
  it('resolves an empty profile to the pre-configuration launcher defaults', () => {
    const r = resolveBulkResolverLaunch({});
    expect(r.ok).toBe(true);
    expect(r.effective).toEqual({
      model: null,
      effort: null,
      account: 'default',
      carry: 'warm',
      backend: 'claude',
    });
  });

  it('treats a missing profile the same as an empty one', () => {
    expect(resolveBulkResolverLaunch(null).effective).toEqual(resolveBulkResolverLaunch({}).effective);
    expect(resolveBulkResolverLaunch(undefined).effective).toEqual(resolveBulkResolverLaunch({}).effective);
  });

  it('treats a blank model/effort string as "inherit", not as a value', () => {
    const r = resolveBulkResolverLaunch({ model: '   ', effort: '  ' as never });
    expect(r.ok).toBe(true);
    expect(r.effective?.model).toBeNull();
    expect(r.effective?.effort).toBeNull();
  });
});

describe('resolveBulkResolverLaunch — backend is DERIVED from the model (D-002)', () => {
  it.each(CLOUD_MODEL_MENU.map((c) => [c.value, c.backend] as const))(
    'infers %s -> %s from the same menu the picker renders',
    (model, backend) => {
      const r = resolveBulkResolverLaunch({ model });
      expect(r.ok).toBe(true);
      expect(r.effective?.backend).toBe(backend);
    },
  );

  it('routes a host-local provider/id to the omp backend', () => {
    const r = resolveBulkResolverLaunch({ model: 'ollama/llama3' });
    expect(r.ok).toBe(true);
    expect(r.effective?.backend).toBe('omp');
  });

  it('REFUSES a model whose backend is ambiguous rather than guessing a CLI', () => {
    // launchAgentBackendForModel returns null for a full id on purpose: its own
    // doc comment says the start-route validator must refuse the ambiguity.
    const r = resolveBulkResolverLaunch({ model: 'claude-fable-5' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('model');
    expect(r.message).toMatch(/does not resolve to a single CLI backend/);
  });
});

describe('resolveBulkResolverLaunch — per-field refusals', () => {
  it('refuses an unknown carry mode', () => {
    const r = resolveBulkResolverLaunch({ carry: 'lukewarm' as never });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('carry');
  });

  it('refuses an account value the scripted path would reject', () => {
    const r = resolveBulkResolverLaunch({ account: 'not a valid account!' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('account');
  });

  it('accepts the three legitimate account shapes', () => {
    for (const account of ['default', 'auto', 'pool-account-7']) {
      expect(resolveBulkResolverLaunch({ account }).ok).toBe(true);
    }
  });

  it('refuses effort with no model to ride on', () => {
    // psu carries effort only as `<model>:<effort>`, so this would be DROPPED.
    const r = resolveBulkResolverLaunch({ model: null, effort: 'high' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('effort');
    expect(r.message).toMatch(/needs a model/);
  });

  it('refuses an unrecognized effort level', () => {
    const r = resolveBulkResolverLaunch({ model: 'sonnet', effort: 'turbo' as never });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('effort');
  });

  it('refuses the marketing-name model typo with the corrective suggestion', () => {
    const r = resolveBulkResolverLaunch({ model: 'sonnet-5' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('model');
    expect(r.message).toMatch(/Did you mean/);
  });

  it('refuses a model longer than the stored column allows', () => {
    const r = resolveBulkResolverLaunch({ model: 'a'.repeat(121) });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('model');
  });

  it('normalizes a recognized effort to lower case', () => {
    const r = resolveBulkResolverLaunch({ model: 'opus', effort: 'XHIGH' as never });
    expect(r.ok).toBe(true);
    expect(r.effective?.effort).toBe('xhigh');
  });
});

describe('P-004 justification: the launch validator is not the document validator', () => {
  it('documentAcceptsWhatLaunchRefuses — a VALID stored profile can still be unlaunchable', () => {
    // `sonnet-5` is a non-empty <=120-char string and 'high' is a real effort
    // level, so the config document is perfectly happy with this profile...
    const profile = { model: 'sonnet-5', effort: 'high' as const, account: 'default', carry: 'warm' as const };
    expect(bulkResolverLaunchProfilesProblem({ 'inbox-resolve': profile })).toBeNull();

    // ...and psu cannot run it. Only the launch preflight catches that.
    const r = resolveBulkResolverLaunch(profile);
    expect(r.ok).toBe(false);
    expect(r.field).toBe('model');
  });

  it('refusesEveryComboThatWouldThrow — nothing this accepts can throw at compose time', () => {
    const combos: Array<{ model: string | null; effort: string | null }> = [
      { model: null, effort: 'high' }, // throws: effort needs a model
      { model: 'sonnet', effort: 'turbo' }, // throws: unrecognized effort
      { model: 'sonnet', effort: 'max' }, // fine
      { model: 'opus', effort: null }, // fine
      { model: null, effort: null }, // fine
    ];
    let throwingCombos = 0;
    for (const combo of combos) {
      const accepted = resolveBulkResolverLaunch(combo as never).ok;
      let composeThrew = false;
      try {
        composeLaunchModelSpec(combo.model, combo.effort);
      } catch {
        composeThrew = true;
      }
      // The invariant: preflight accepts a combination ONLY if composing it is
      // safe. A combo that throws must never reach createRun.
      if (composeThrew) {
        throwingCombos += 1;
        expect(accepted).toBe(false);
      }
    }
    // Without this the assertion above is vacuous: a table where nothing throws
    // would pass while proving nothing at all.
    expect(throwingCombos).toBe(2);
  });
});

describe('buildResolverLaunchCommand — threading the effective settings', () => {
  const base = { workspaceId: 'papercusp-workspace', harness: 'papercusp', ownerId: 'su-test-1' };

  it('is byte-identical to the pre-configuration launch when no settings are posted', () => {
    const before = buildResolverLaunchCommand(base);
    expect(buildResolverLaunchCommand({ ...base, launch: null })).toBe(before);
    expect(before).toContain('--account=default');
    expect(before).toContain('--agent=claude');
    expect(before).toContain('--carry=warm');
  });

  it('threads model, effort, account, carry and the DERIVED agent backend', () => {
    const launch = preflightResolverLaunch({
      model: 'sol',
      effort: 'high',
      account: 'auto',
      carry: 'cold',
    });
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;

    const command = buildResolverLaunchCommand({ ...base, launch: launch.launch });
    expect(command).toContain('--account=auto');
    expect(command).toContain('--carry=cold');
    // effort rides the model spec; psu has no standalone --effort flag.
    expect(command).toContain('--model=sol:high');
    // 'sol' is a codex alias, so the agent is codex — NOT the hardcoded claude.
    expect(command).toContain('--agent=codex');
    // Fixed launch invariants survive configuration.
    expect(command).toContain('--headless');
    expect(command).toContain('--role=su');
  });
});

describe('preflightResolverLaunch — the shared start-route gate', () => {
  it('answers 400 with a field-scoped code the pane can mark', async () => {
    const out = preflightResolverLaunch({ model: 'sonnet-5' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.response.status).toBe(400);
    const body = (await out.response.json()) as { error: { code: string; field?: string; message: string } };
    expect(body.error.code).toBe('invalid_launch_settings');
    expect(body.error.field).toBe('model');
    expect(body.error.message).toMatch(/Did you mean/);
  });

  it('accepts a body that posts no launch settings at all', () => {
    const out = preflightResolverLaunch(undefined);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.launch.account).toBe('default');
    expect(out.launch.backend).toBe('claude');
  });

  it('ignores a non-object launch value rather than throwing', () => {
    expect(preflightResolverLaunch('nonsense').ok).toBe(true);
    expect(preflightResolverLaunch([1, 2, 3]).ok).toBe(true);
  });
});
