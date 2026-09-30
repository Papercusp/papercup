/**
 * P-006 (fuzzy-tool-name-resolution-2026-07-02): the flag-gated dispatch resolver. The kill-switch
 * must withhold ONLY the fuzzy stage — exact + canonical fold stay on with the flag OFF — and a
 * fuzzy result must be tagged so the seam can annotate it (D-008).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from '@papercusp/agent-mcp';
import { resolveDispatchTarget } from './resolve-dispatch-target';

const noop: ProjectedTool['fn'] = async () => ({ content: [{ type: 'text', text: 'ok' }] });
const reg = (name: string): ProjectedTool => {
  const tool: ProjectedTool = {
    pluginName: `p-${name}`,
    description: 'fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    expose: { mcp: { name } },
    effect: 'read',
    fn: noop,
  };
  registerProjectedTool(tool);
  return tool;
};
const on = { fuzzyEnabled: async () => true };
const off = { fuzzyEnabled: async () => false };

afterEach(() => _resetProjectionRegistryForTests());

describe('resolveDispatchTarget', () => {
  it('flag ON: a typo resolves and is tagged fuzzy', async () => {
    const t = reg('curation:state-of-pot');
    const r = await resolveDispatchTarget('curationn:state-of-pot', {}, on);
    expect(r.tool).toBe(t);
    expect(r.via).toBe('fuzzy');
    expect(r.input).toBe('curationn:state-of-pot');
  });

  it('flag OFF: the SAME typo is a miss — the kill-switch withholds only the fuzzy stage', async () => {
    reg('curation:state-of-pot');
    const r = await resolveDispatchTarget('curationn:state-of-pot', {}, off);
    expect(r.tool).toBeUndefined();
    expect(r.alternatives).toEqual([]);
  });

  it('flag OFF: exact and canonical-fold names still resolve, tagged as such', async () => {
    const t = reg('curation:state-of-pot');
    const exact = await resolveDispatchTarget('curation:state-of-pot', {}, off);
    expect(exact.tool).toBe(t);
    expect(exact.via).toBe('exact');
    const folded = await resolveDispatchTarget('mcp__papercusp-su__curation_state-of-pot', {}, off);
    expect(folded.tool).toBe(t);
    expect(folded.via).toBe('canonical');
    expect(folded.resolvedName).toBe('curation:state-of-pot');
  });

  it('flag OFF still honours the caller-visible set (D-009)', async () => {
    reg('coord:hidden-one');
    const r = await resolveDispatchTarget('coord:hidden-one', { visible: () => false }, off);
    expect(r.tool).toBeUndefined();
  });
});
