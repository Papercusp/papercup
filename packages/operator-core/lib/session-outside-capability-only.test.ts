import { describe, expect, it, vi } from 'vitest';
import { FLEET_CAPABILITY_REPLACED_TOOLS } from '@papercusp/orchestrator';
import {
  OUTSIDE_SESSION_CAPABILITY_TOOLS,
  OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS,
  outsideSessionCapabilityOnly,
} from './session-outside-capability-only';
import { loopRefusalReason } from './verification-attempts/loop-gate';

const on = async () => true;
const off = async () => false;
const outside = { agent: 'claude', outsidePlanRef: 'batch-7' };

describe('outsideSessionCapabilityOnly', () => {
  it('gives a Claude Code session on an outside plan both lists when the flag is on', async () => {
    const terms = await outsideSessionCapabilityOnly(outside, on);
    expect(terms).toEqual({
      withdrawnNativeTools: ['Bash', 'Edit', 'Write', 'WebFetch', 'NotebookEdit'],
      tools: [
        'capability:write',
        'capability:edit',
        'capability:patch',
        'capability:bash',
        'capability:bash_output',
        'work_items:comment',
      ],
    });
  });

  it('gives the session the tool the shell\'s own refusal tells it to call', () => {
    // capability:bash holds a looping item's next slow run until an audit note is on the item.
    const refusal = loopRefusalReason('WI-7', {
      tripped: true,
      triggers: ['distinct-failures'],
      windowStartedAt: null,
      windowAttempts: 2,
      windowFailures: 2,
      windowMs: 600_000,
      budgetMs: 14_400_000,
      fingerprints: ['a1', 'b2'],
      labels: {},
      incompleteAudit: null,
    });
    const named = [...refusal.matchAll(/\b([a-z_]+:[a-z_-]+) \{/g)].map((match) => match[1]);
    expect(named).toEqual(['work_items:comment']);
    for (const tool of named) expect(OUTSIDE_SESSION_CAPABILITY_TOOLS).toContain(tool);
  });

  it('withdraws every tool the flag withdraws from a spawned agent, and the notebook editor', () => {
    for (const tool of FLEET_CAPABILITY_REPLACED_TOOLS) expect(OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS).toContain(tool);
    expect(OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS).toContain('NotebookEdit');
    // The tools a session reads and searches with stay.
    for (const kept of ['Read', 'Glob', 'Grep']) expect(OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS).not.toContain(kept);
  });

  it('never withdraws a way to write or run without naming its stand-in', () => {
    const standIn: Record<string, string[]> = {
      Bash: ['capability:bash', 'capability:bash_output'],
      Edit: ['capability:edit', 'capability:patch'],
      Write: ['capability:write'],
      NotebookEdit: ['capability:write'],
      WebFetch: [],
    };
    for (const tool of OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS) {
      expect(standIn[tool], `no stand-in recorded for ${tool}`).toBeDefined();
      for (const replacement of standIn[tool]) expect(OUTSIDE_SESSION_CAPABILITY_TOOLS).toContain(replacement);
    }
  });

  it('leaves the session its own tools when the flag is off', async () => {
    expect(await outsideSessionCapabilityOnly(outside, off)).toBeNull();
  });

  it('leaves a session that is not on an outside plan alone, without reading the flag', async () => {
    const enabled = vi.fn(on);
    expect(await outsideSessionCapabilityOnly({ agent: 'claude', outsidePlanRef: null }, enabled)).toBeNull();
    expect(enabled).not.toHaveBeenCalled();
  });

  it('leaves another agent alone: the withdrawn names are Claude Code\'s', async () => {
    const enabled = vi.fn(on);
    for (const agent of ['codex', 'omp']) {
      expect(await outsideSessionCapabilityOnly({ agent, outsidePlanRef: 'batch-7' }, enabled)).toBeNull();
    }
    expect(enabled).not.toHaveBeenCalled();
  });

  it('counts a flag that cannot be read as off', async () => {
    const terms = await outsideSessionCapabilityOnly(outside, async () => {
      throw new Error('flag store unreachable');
    });
    expect(terms).toBeNull();
  });

  it('hands out copies, so a caller cannot change the lists for the next launch', async () => {
    const first = await outsideSessionCapabilityOnly(outside, on);
    first!.tools.push('tools:invoke');
    first!.withdrawnNativeTools.length = 0;
    const second = await outsideSessionCapabilityOnly(outside, on);
    expect(second!.tools).toEqual([...OUTSIDE_SESSION_CAPABILITY_TOOLS]);
    expect(second!.withdrawnNativeTools).toEqual([...OUTSIDE_SESSION_WITHDRAWN_NATIVE_TOOLS]);
  });
});
