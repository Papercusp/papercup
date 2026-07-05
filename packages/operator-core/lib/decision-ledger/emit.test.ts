/**
 * Unit tests for the decision-ledger row builder
 * (agent-capability-confinement-2026-06-13 B-06 / P-011). `buildDecisionLedgerRow` is the
 * PURE governed-action filter + field computation — no PG, no flag — so it is tested
 * directly. The flag-gate + INSERT are integration concerns wired in projected-tool-deps.
 */

import { describe, expect, it } from 'vitest';
import { buildDecisionLedgerRow } from './emit';
import type { PostInvokeEvent } from '@papercusp/agent-mcp';

function ev(opts: {
  capabilities?: readonly string[];
  ctx?: Partial<PostInvokeEvent['ctx']>;
  result?: PostInvokeEvent['result'];
  envelopeVerdict?: PostInvokeEvent['envelopeVerdict'];
  args?: unknown;
  toolName?: string;
} = {}): PostInvokeEvent {
  const ctx = {
    workspaceId: 'default',
    harnessSlug: 'papercup',
    role: 'worker',
    runId: 'run_1',
    spawnId: 'spw_1',
    ...(opts.ctx ?? {}),
  } as PostInvokeEvent['ctx'];
  return {
    toolName: opts.toolName ?? 'plans.set-status',
    pluginName: 'agent-mcp',
    args: opts.args ?? { slug: 'p', status: 'wip' },
    result: opts.result ?? { ok: true, result: { content: [] } },
    ctx,
    durationMs: 42,
    capabilities: opts.capabilities ?? ['plans:write'],
    envelopeVerdict: opts.envelopeVerdict,
  };
}

describe('buildDecisionLedgerRow — skip filters', () => {
  it('skips when there is no workspace', () => {
    expect(buildDecisionLedgerRow(ev({ ctx: { workspaceId: undefined } }))).toBeNull();
  });

  it('skips superuser calls (D-002 — supervised human, not autonomous Queen)', () => {
    expect(buildDecisionLedgerRow(ev({ ctx: { isSuperuser: true } }))).toBeNull();
  });

  it('skips tools with no declared capability (public/ungated utility)', () => {
    expect(buildDecisionLedgerRow(ev({ capabilities: [] }))).toBeNull();
  });

  it('skips reads (tier low) — not governance actions (D-003)', () => {
    expect(buildDecisionLedgerRow(ev({ capabilities: ['plans:read'], toolName: 'plans.get' }))).toBeNull();
  });

  // EI-597: dual-mode coord verbs declare `coord:write` (tier medium) but their
  // READ paths must not be logged as governed actions, or a client polling them
  // floods the ledger out of its retained window (queen-loop-alignment D-006).
  it('skips a read-shaped coord:wake-mode poll (no mode) — EI-597', () => {
    expect(
      buildDecisionLedgerRow(ev({ capabilities: ['coord:write'], toolName: 'coord:wake-mode', args: { agent: 'su-x' } })),
    ).toBeNull();
  });

  it('skips a read-shaped coord:wake-queue poll (default/explicit list) — EI-597', () => {
    expect(
      buildDecisionLedgerRow(ev({ capabilities: ['coord:write'], toolName: 'coord:wake-queue', args: { agent: 'su-x' } })),
    ).toBeNull();
    expect(
      buildDecisionLedgerRow(ev({ capabilities: ['coord:write'], toolName: 'coord:wake-queue', args: { action: 'list' } })),
    ).toBeNull();
  });
});

describe('buildDecisionLedgerRow — governed actions', () => {
  it('records a governed write with derived tier + authoritative category + surface axes + posture auto', () => {
    const row = buildDecisionLedgerRow(ev());
    expect(row).not.toBeNull();
    expect(row!.tier).toBe('medium');
    // B-04 authoritative category (plans:set-status → plan-governance), not the coarse group.
    expect(row!.category).toBe('plan-governance');
    // B-02/B-01 per-action-TYPE axes from ACTION_SURFACE (plans:set-status is a Queen verb).
    expect(row!.reversibility).toBe('reversible');
    expect(row!.authority).toBe('owner');
    expect(row!.capability).toBe('plans:write');
    expect(row!.posture).toBe('auto');
    expect(row!.outcome).toBe('ok');
    expect(row!.outcomeCode).toBeNull();
    expect(row!.actorRole).toBe('worker');
    expect(row!.actorSpawnId).toBe('spw_1');
    expect(row!.links).toMatchObject({ runId: 'run_1', spawnId: 'spw_1' });
    // the digest is the SORTED top-level arg key names (never the values).
    expect(row!.argsDigest).toBe('slug,status');
  });

  it('derives tier high for a high-tier capability + NULL axes off the Queen surface', () => {
    const row = buildDecisionLedgerRow(ev({ capabilities: ['secrets:read:db'], toolName: 'secrets.read' }));
    expect(row!.tier).toBe('high');
    expect(row!.category).toBe('credentials-auth');
    // secrets:read is not a human-driving Queen action → no per-action-type axes (honest null).
    expect(row!.reversibility).toBeNull();
    expect(row!.authority).toBeNull();
  });

  it('takes the highest tier across multiple capabilities', () => {
    const row = buildDecisionLedgerRow(ev({ capabilities: ['plans:read', 'plans:write'] }));
    expect(row!.tier).toBe('medium');
  });

  it('carries the envelope posture + reason when the verdict is gated (observe/shadow)', () => {
    const row = buildDecisionLedgerRow(
      ev({ envelopeVerdict: { decision: 'observe', posture: 'gated', applied: true, reason: 'would-deny' } }),
    );
    expect(row!.posture).toBe('gated');
    expect(row!.why).toBe('would-deny');
  });

  it('records a rejected action (envelope-denied) as posture rejected + outcome error', () => {
    const row = buildDecisionLedgerRow(
      ev({
        result: { ok: false, error: { code: 'capability_denied', message: 'outside envelope' } },
        envelopeVerdict: { decision: 'deny', posture: 'rejected', applied: true, reason: 'protected' },
      }),
    );
    expect(row!.posture).toBe('rejected');
    expect(row!.outcome).toBe('error');
    expect(row!.outcomeCode).toBe('capability_denied');
    expect(row!.why).toBe('protected');
  });

  it('normalizes a dotted tool name to colon form for the B-04 map (bee.spawn → agent-lifecycle)', () => {
    const row = buildDecisionLedgerRow(ev({ capabilities: ['cup:spawn'], toolName: 'bee.spawn' }));
    expect(row!.category).toBe('agent-lifecycle');
    expect(row!.tier).toBe('medium');
  });

  // EI-597: only the READ paths of the dual-mode coord verbs are skipped — their
  // WRITES (set a mode; release/skip a wake) are genuine governed actions + still log.
  it('records a coord:wake-mode WRITE (mode set) — only its reads are skipped (EI-597)', () => {
    const row = buildDecisionLedgerRow(
      ev({ capabilities: ['coord:write'], toolName: 'coord:wake-mode', args: { mode: 'manual' } }),
    );
    expect(row).not.toBeNull();
    expect(row!.action).toBe('coord:wake-mode');
    expect(row!.tier).toBe('medium');
  });

  it('records a coord:wake-queue WRITE (release) — only its list reads are skipped (EI-597)', () => {
    const row = buildDecisionLedgerRow(
      ev({ capabilities: ['coord:write'], toolName: 'coord:wake-queue', args: { agent: 'su-x', action: 'release', id: 3 } }),
    );
    expect(row).not.toBeNull();
    expect(row!.action).toBe('coord:wake-queue');
  });
});
