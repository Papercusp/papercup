import { describe, expect, it, vi } from 'vitest';
import type { FleetHeadcountTarget } from '../../agent-fleets-store';
import {
  resolveLoadedSavedFleetLaunchSpec,
  resolveSavedFleetLaunchSpec,
  savedFleetLaunchSpecFromConfig,
} from './saved-launch-spec';

const target: FleetHeadcountTarget = {
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  target: 16,
  config: {
    plan: 'byoc-plan',
    harness: 'papercusp',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    account: 'default',
    headless: true,
    carry: 'warm',
    role: 'su',
    brief: 'drain the plan',
    launchContext: '/tmp/byoc.md',
    contextSize: 'trimmed',
    compactionLimit: 400_000,
    extraArgs: ['--safe-flag'],
  },
  nextAttemptAt: null,
  backoffMs: 0,
  lastError: null,
};

const base = {
  target,
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  reusePath: 'fleet:respawn-member -> capability:launch-agent',
};

describe('saved fleet launch spec resolver (agent-launch-unification P-043)', () => {
  it('materializes the canonical command-neutral spec and defaults saved visibility to headless', () => {
    expect(savedFleetLaunchSpecFromConfig({ ...target.config, headless: undefined })).toMatchObject({
      plan: 'byoc-plan',
      harness: 'papercusp',
      member: {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        headless: true,
        carry: 'warm',
      },
    });
  });

  it('preserves every omitted saved field and records provenance + reuse path', () => {
    const result = resolveLoadedSavedFleetLaunchSpec(base);
    expect(result).toMatchObject({
      ok: true,
      found: true,
      target: 16,
      effective: { plan: 'byoc-plan', harness: 'papercusp', member: { agent: 'codex', headless: true } },
      overrides: [],
      provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
    });
    if (!result.ok || !result.found) throw new Error('expected saved resolution');
    expect(result.preservedFields).toEqual([
      'plan',
      'harness',
      'agent',
      'model',
      'account',
      'headless',
      'carry',
      'role',
      'brief',
      'launchContext',
      'contextSize',
      'compactionLimit',
      'extraArgs',
    ]);
  });

  it('normalizes a repeated composed model spec instead of reporting a false conflict', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { model: 'gpt-5.6-sol:xhigh', headless: true },
    });
    expect(result).toMatchObject({ ok: true, found: true, overrides: [] });
  });

  it('applies only allowlisted deltas and preserves an omitted effort across a bare model change', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { model: 'gpt-5.6-terra', headless: false, brief: 'resume the held lane' },
      allowDeltas: ['model', 'headless', 'brief'],
    });
    expect(result).toMatchObject({
      ok: true,
      found: true,
      effective: {
        member: {
          model: 'gpt-5.6-terra',
          effort: 'xhigh',
          headless: false,
          brief: 'resume the held lane',
          carry: 'warm',
        },
      },
    });
    if (!result.ok || !result.found) throw new Error('expected saved resolution');
    expect(result.overrides.map((row) => row.field)).toEqual(['model', 'headless', 'brief']);
    expect(result.overrides[0]).toMatchObject({
      saved: 'gpt-5.6-sol:xhigh',
      requested: 'gpt-5.6-terra:xhigh',
      provenance: { source: 'fleet:headcount-target' },
      reusePath: base.reusePath,
    });
  });

  it('fails closed with saved/requested/provenance/reuse-path diagnostics for unaudited differences', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { account: 'auto', headless: false },
    });
    expect(result).toMatchObject({ ok: false, found: true, error: 'saved_launch_spec_conflict' });
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts).toEqual([
      {
        field: 'account',
        saved: 'default',
        requested: 'auto',
        provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
        reusePath: base.reusePath,
      },
      {
        field: 'headless',
        saved: true,
        requested: false,
        provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
        reusePath: base.reusePath,
      },
    ]);
    expect(result.message).toContain('Saved launch spec conflict');
  });

  it('rejects per-member, launch-context, claim-kind, and unpersisted reconstruction', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: {
        members: [{ model: 'gpt-5.6-terra' }],
        perMemberLaunchContext: ['/tmp/other.md'],
        claimKinds: ['bug'],
        allowSubagents: true,
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'saved_launch_spec_conflict' });
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts.map((row) => row.field)).toEqual([
      'members',
      'perMemberLaunchContext',
      'claimKinds',
      'allowSubagents',
    ]);
  });

  it('distinguishes a fresh launch from a recovery that requires a saved spec', () => {
    expect(resolveLoadedSavedFleetLaunchSpec({ ...base, target: null })).toMatchObject({
      ok: true,
      found: false,
    });
    expect(resolveLoadedSavedFleetLaunchSpec({ ...base, target: null, requireSaved: true })).toMatchObject({
      ok: false,
      found: false,
      error: 'saved_launch_spec_missing',
    });
  });

  it('fails closed when the canonical read or stored model/effort pair is invalid', async () => {
    const readTarget = vi.fn().mockRejectedValue(new Error('pg unavailable'));
    await expect(resolveSavedFleetLaunchSpec({ ...base, readTarget })).resolves.toMatchObject({
      ok: false,
      found: false,
      error: 'saved_launch_spec_read_failed',
    });

    expect(
      resolveLoadedSavedFleetLaunchSpec({
        ...base,
        target: { ...target, config: { ...target.config, model: undefined, effort: 'xhigh' } },
      }),
    ).toMatchObject({ ok: false, found: true, error: 'saved_launch_spec_invalid' });
  });
});
