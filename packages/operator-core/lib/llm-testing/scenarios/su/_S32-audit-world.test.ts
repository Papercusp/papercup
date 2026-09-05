/**
 * Pins the SU-S32 audit world: the churn markers it exists to expose must stay
 * readable through the tool surface, and unmodelled tools must still pass
 * through to the target's stub (a world that swallows everything would hide a
 * fan-out the assertions are meant to see).
 */
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { ToolResult } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';

import { AUDIT_WORLD, AUDIT_WORLD_CENSUS, AUDIT_WORLD_ITEMS, AUDIT_WORLD_PLANS } from './_S32-audit-world';

async function call(name: string, args: unknown = {}): Promise<Record<string, any>> {
  const res = await AUDIT_WORLD.override(name, args);
  if (res === PASS_THROUGH) throw new Error(`${name} passed through`);
  return JSON.parse((res as ToolResult).content[0]!.text!);
}

describe('SU-S32 audit world', () => {
  it('plans:list defaults to draft+active and SAYS what it omitted; status:all returns the full lifecycle', async () => {
    const dflt = await call('plans:list', { harness: 'p2p' });
    const shown = new Set(dflt.plans.map((p: any) => p.status));
    expect([...shown].sort()).toEqual(['active', 'draft']);
    expect(dflt.note).toMatch(/shipped\/superseded\/archived omitted/);
    expect(dflt.statusCounts).toEqual({ draft: 1, active: 2, shipped: 2, superseded: 1, archived: 1 });

    const all = await call('plans:list', { harness: 'p2p', status: 'all' });
    expect(all.plans).toHaveLength(AUDIT_WORLD_PLANS.length);
    expect(all.note).toBeUndefined();
    expect(new Set(all.plans.map((p: any) => p.status)).size).toBe(5);
  });

  it('the stale ## Now contradicts the ledger: NAT P-008/P-009 are blocked on a DONE item', async () => {
    const nat = (await call('plans:get', { slug: 'p2p-nat-traversal-2026-05-28' })).plan;
    expect(nat.now.state).toMatch(/all remaining items in flight/);
    const p004 = nat.items.find((i: any) => i.id === 'P-004');
    expect(p004.status).toBe('done');
    for (const id of ['P-008', 'P-009']) {
      const it = nat.items.find((i: any) => i.id === id);
      expect(it.status).toBe('blocked');
      expect(it.blockedBy).toBe('P-004');
    }
  });

  it('work_items:list carries the whole-program census on every read, never just the slice', async () => {
    const open = await call('work_items:list', { state: 'open' });
    expect(open.items.every((r: any) => r.state === 'open')).toBe(true);
    expect(open.census).toEqual(AUDIT_WORLD_CENSUS);
    expect(open.census.truncatedByLimit).toBe(true);
    expect(open.census.total).toBeGreaterThan(AUDIT_WORLD_ITEMS.length);
  });

  it('exposes repeat prior-workers, re-opens and a re-validation loop', async () => {
    const get = await call('work_items:get', { ids: ['WI-7301', 'WI-6980', 'WI-7311'] });
    const byId = Object.fromEntries(get.results.map((r: any) => [r.id, r.workItem]));
    expect(byId['WI-7301'].priorWorkers).toHaveLength(3);
    expect(new Set(byId['WI-7301'].priorWorkers).size).toBe(2);
    expect(byId['WI-6980'].reopenCount).toBe(1);
    expect(byId['WI-7311'].title).toMatch(/#4/);
  });

  it('coord:presence shows the WI-7150 holder as ENDED (a stranded claim)', async () => {
    const presence = await call('coord:presence');
    const holder = presence.agents.find((ag: any) => ag.claims.includes('WI-7150'));
    expect(holder.sessionState).toBe('ended');
    const wi = (await call('work_items:get', { id: 'WI-7150' })).results[0].workItem;
    expect(wi.assignee).toBe(holder.ownerId);
  });

  it('mode:set registers the audit with its scope asserted as a standing fact', async () => {
    const r = await call('mode:set', { mode: 'audit', ownerDirected: true, instructions: 'the p2p program', reason: 'owner asked' });
    expect(r.ok).toBe(true);
    expect(r.impliesAutonomy).toBe(false);
    expect(r.instructionsFact).toBe('asserted');
    expect(r.contract).toContain("mode:set { mode:'audit', enabled:false");
    expect(r.contract).toContain('that exit call is your FIRST action');
    expect(r.contract).toContain('standalone tool call');
    expect(r.contract).toContain('never batch the exit with subject mutations');
  });

  it('coord:orient re-injects the same active AUDIT contract before a later-turn mutation', async () => {
    const entered = await call('mode:set', { mode: 'audit', ownerDirected: true, instructions: 'the p2p program' });
    const oriented = await call('coord:orient', { intent: 'Owner-routed remediation' });
    expect(oriented.activeModes).toEqual([
      expect.objectContaining({ mode: 'audit', axis: 'overlay', contract: entered.contract }),
    ]);
    expect(oriented.activeModes[0].contract).toContain('wait for its successful result');
  });

  it('canonicalises the mcp prefix and passes unmodelled tools through', async () => {
    const prefixed = await AUDIT_WORLD.override('mcp__agentmcp__plans:list', {});
    expect(prefixed).not.toBe(PASS_THROUGH);
    expect(await AUDIT_WORLD.override('docs:search', { query: 'x' })).toBe(PASS_THROUGH);
    expect(await AUDIT_WORLD.override('plans:set-now', { slug: 'p2p-nat-traversal-2026-05-28' })).toBe(PASS_THROUGH);
  });
});
