import { describe, expect, it } from 'vitest';
import {
  isStoodDownOwner,
  readEngineLoopRowsByOwner,
  type EngineLoopRowsByOwner,
} from './engine-loop-standdown';

describe('isStoodDownOwner — the EI-21275606411048371 stand-down signal', () => {
  it('never-armed owner (no rows) is NOT stood down — WI-6054 rescues exactly them', () => {
    expect(isStoodDownOwner({}, 'su-a')).toBe(false);
    expect(isStoodDownOwner({ 'su-b': [] }, 'su-b')).toBe(false);
    expect(isStoodDownOwner(null, 'su-c')).toBe(false);
    expect(isStoodDownOwner(undefined, 'su-d')).toBe(false);
  });

  it('an owner with any ACTIVE loop row is NOT stood down (mid-mission)', () => {
    const rows: EngineLoopRowsByOwner = {
      'su-live': [{ active: true }],
      'su-multi': [{ active: false }, { active: true }],
    };
    expect(isStoodDownOwner(rows, 'su-live')).toBe(false);
    // ANY active row wins — suppression must never fire on partial evidence.
    expect(isStoodDownOwner(rows, 'su-multi')).toBe(false);
  });

  it('an owner whose loop row(s) are ALL inactive IS stood down (loop:end ran)', () => {
    const rows: EngineLoopRowsByOwner = {
      'su-ended': [{ active: false }],
      'su-two-loops': [{ active: false }, { active: false }],
    };
    expect(isStoodDownOwner(rows, 'su-ended')).toBe(true);
    expect(isStoodDownOwner(rows, 'su-two-loops')).toBe(true);
  });
});

describe('readEngineLoopRowsByOwner', () => {
  /** Captures the tagged-template query so the SQL shape is pinned without PG. */
  function fakeSql(rows: { target_owner_id: string; active: boolean }[]) {
    const calls: { strings: string[]; args: unknown[] }[] = [];
    const fn = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      calls.push({ strings: [...strings], args });
      return Promise.resolve(rows);
    }) as never;
    return { fn, calls };
  }

  it('short-circuits with no query when there is nothing to look up', async () => {
    const { fn, calls } = fakeSql([]);
    await expect(readEngineLoopRowsByOwner([], { sql: fn })).resolves.toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('identifies loops the established gc-dead-loops way: name LIKE loop-% + target_owner_id, workspace-scoped', async () => {
    const { fn, calls } = fakeSql([
      { target_owner_id: 'su-ended', active: false },
      { target_owner_id: 'su-live', active: true },
    ]);
    const got = await readEngineLoopRowsByOwner(['su-ended', 'su-live'], {
      sql: fn,
      workspaceId: 'ws-x',
    });
    expect(got).toEqual({
      'su-ended': [{ active: false }],
      'su-live': [{ active: true }],
    });
    expect(calls).toHaveLength(1);
    const text = calls[0].strings.join('?');
    expect(text).toContain("r.workspace_id = ?");
    expect(text).toContain("r.name LIKE 'loop-%'");
    expect(text).toContain('r.target_owner_id IS NOT NULL');
    expect(text).toContain('r.target_owner_id = ANY(?)');
    expect(calls[0].args[0]).toBe('ws-x');
    expect(calls[0].args[1]).toEqual(['su-ended', 'su-live']);
  });

  it('groups multiple rows per owner so ALL-inactive can be decided in JS', async () => {
    const { fn } = fakeSql([
      { target_owner_id: 'su-x', active: false },
      { target_owner_id: 'su-x', active: true },
    ]);
    const got = await readEngineLoopRowsByOwner(['su-x'], { sql: fn, workspaceId: 'ws' });
    expect(got['su-x']).toHaveLength(2);
    expect(isStoodDownOwner(got, 'su-x')).toBe(false);
  });
});
