import { describe, expect, it, vi } from 'vitest';
import {
  shouldPushNeedsHuman,
  itemImportance,
  flipStatusInBody,
  truncateInlineNote,
  isTerminalStatus,
  releaseTerminalGrips,
  releaseTodoClaim,
  terminalFlipConflict,
  type HolderInfo,
} from './set-status';

// P-020 (planning-attention-importance): plans:set-status pushes a
// notification when an item transitions INTO needs-human at importance
// >= high. These cover the two pure pieces of that gate; the push itself
// (notifyWorkspace) is the proven mobile-delivery path exercised elsewhere.

// Caller-DX (watchdog P-006): an over-long inline note is truncated-with-marker,
// not rejected — the agent never bounces; the long form belongs in `rationale`.
describe('truncateInlineNote (P-006)', () => {
  it('passes a short note through untouched', () => {
    expect(truncateInlineNote('short note')).toEqual({ note: 'short note', truncated: false });
  });
  it('passes undefined through (no note)', () => {
    expect(truncateInlineNote(undefined)).toEqual({ note: undefined, truncated: false });
  });
  it('keeps a note exactly at the 1000-char cap', () => {
    const exact = 'x'.repeat(1000);
    expect(truncateInlineNote(exact)).toEqual({ note: exact, truncated: false });
  });
  it('truncates an over-cap note to 1000 chars with an ellipsis marker', () => {
    const out = truncateInlineNote('y'.repeat(1500));
    expect(out.truncated).toBe(true);
    expect(out.note).toHaveLength(1000);
    expect(out.note!.endsWith('…')).toBe(true);
    expect(out.note!.slice(0, 999)).toBe('y'.repeat(999));
  });
});

describe('shouldPushNeedsHuman', () => {
  it('fires on a fresh needs-human flip at urgent/high', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'urgent')).toBe(true);
    expect(shouldPushNeedsHuman('todo', 'needs-human', 'high')).toBe(true);
    expect(shouldPushNeedsHuman(null, 'needs-human', 'urgent')).toBe(true);
  });

  it('does NOT fire below high importance', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'normal')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'low')).toBe(false);
  });

  it('does NOT fire when the item was already needs-human (re-set, not a transition)', () => {
    expect(shouldPushNeedsHuman('needs-human', 'needs-human', 'urgent')).toBe(false);
  });

  it('does NOT fire for non-needs-human target statuses', () => {
    expect(shouldPushNeedsHuman('todo', 'done', 'urgent')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'blocked', 'high')).toBe(false);
  });
});

describe('itemImportance', () => {
  const body = [
    '## Phase 1',
    '',
    '- **P-001** `todo` plain item, no keyword',
    '- **P-002** `wip` urgent one importance: urgent',
    '- **P-003** `todo` high one blocked-by: P-001 importance: high',
    '- **P-004** `done` explicit normal importance: normal',
    '- **P-005** `todo` bogus value importance: spicy',
    '',
  ].join('\n');

  it('defaults to normal when the keyword is absent', () => {
    expect(itemImportance(body, 'P-001')).toBe('normal');
  });

  it('reads the importance keyword regardless of position on the line', () => {
    expect(itemImportance(body, 'P-002')).toBe('urgent');
    expect(itemImportance(body, 'P-003')).toBe('high');
    expect(itemImportance(body, 'P-004')).toBe('normal');
  });

  it('degrades an unrecognised value to normal (no throw)', () => {
    expect(itemImportance(body, 'P-005')).toBe('normal');
  });

  it('returns normal for an unknown item id', () => {
    expect(itemImportance(body, 'P-999')).toBe('normal');
  });

  it('ignores an importance keyword that only appears inside a fenced example', () => {
    const fenced = [
      '## Phase 1',
      '',
      '- **P-010** `todo` real item',
      '',
      '```',
      '- **P-010** `todo` example importance: urgent',
      '```',
      '',
    ].join('\n');
    expect(itemImportance(fenced, 'P-010')).toBe('normal');
  });
});

// EI-2298: a terminal flip (done/dropped) must clear BOTH the caller's live
// claim AND the item's durable ASSIGNMENT. The assignment is item-level and can
// belong to a DIFFERENT agent than the one closing the item (a verify-first
// `done` set by a peer) — if left dangling, the item sits done+assigned-idle
// forever and a dispatcher that re-pokes assigned-idle items re-targets the
// stale assignee endlessly. These guard that exact invariant.
describe('isTerminalStatus', () => {
  it('treats done + dropped as terminal, everything else as non-terminal', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('dropped')).toBe(true);
    expect(isTerminalStatus('wip')).toBe(false);
    expect(isTerminalStatus('todo')).toBe(false);
    expect(isTerminalStatus('blocked')).toBe(false);
    expect(isTerminalStatus('needs-human')).toBe(false);
  });
});

describe('releaseTerminalGrips (EI-2298)', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h' };
  function fakes(assignmentRow: unknown = { itemId: 'P-001' }) {
    const calls = { releaseClaim: [] as unknown[][], clearAssignment: [] as unknown[][] };
    return {
      calls,
      releaseClaim: async (...a: unknown[]) => {
        calls.releaseClaim.push(a);
        return true;
      },
      clearAssignment: async (...a: unknown[]) => {
        calls.clearAssignment.push(a);
        return assignmentRow;
      },
    };
  }
  const at = (slug = 'plan-a', itemId = 'P-001') => ({ scope, slug, itemId });

  it('on done with NO caller identity (a peer verify-first close): still clears the dangling assignment — THE bug', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: null, // the closer is not the assignee
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(true);
    expect(f.calls.clearAssignment).toEqual([['ws', 'h', 'plan-a', 'P-001']]);
    expect(f.calls.releaseClaim).toHaveLength(0); // no caller claim to release
  });

  it('on done with an attributable agent: releases BOTH the caller claim and the assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out).toEqual({ claimReleased: true, assignmentReleased: true });
    expect(f.calls.releaseClaim).toEqual([['ws', 'h', 'plan-a', 'P-001', 'su-x']]);
    expect(f.calls.clearAssignment).toEqual([['ws', 'h', 'plan-a', 'P-001']]);
  });

  it('on dropped: also clears the assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'dropped',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(true);
  });

  it('on a NON-terminal flip (wip): touches neither claim nor assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'wip',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out).toEqual({ claimReleased: false, assignmentReleased: false });
    expect(f.calls.releaseClaim).toHaveLength(0);
    expect(f.calls.clearAssignment).toHaveLength(0);
  });

  it('assignmentReleased=false when there was no active assignment (clearAssignment → null)', async () => {
    const f = fakes(null);
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(false);
  });

  it('is fail-safe: a clearAssignment throw is swallowed → assignmentReleased=false, no throw', async () => {
    // The helper logs the swallowed error via console.warn; mock it so
    // vitest-fail-on-console does not fail the test, and assert it occurred
    // (the fail-safe path IS expected to warn).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: null,
      ...at(),
      releaseClaim: async () => true,
      clearAssignment: async () => {
        throw new Error('pg down');
      },
    });
    expect(out.assignmentReleased).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// EI-5822: a →todo flip is the documented "hand it back to the pool"
// affordance, but only the ASSIGNMENT/status token released — the caller's
// live coord claim LEASE (what actually blocks a peer's next wip-flip with
// claim_conflict) survived until TTL expiry. releaseTodoClaim closes that gap
// WITHOUT touching the durable assignment (unlike a terminal flip).
describe('releaseTodoClaim (EI-5822)', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h' };
  function fakes() {
    const calls: unknown[][] = [];
    return { calls, releaseClaim: async (...a: unknown[]) => { calls.push(a); return true; } };
  }
  const at = (slug = 'plan-a', itemId = 'P-001') => ({ scope, slug, itemId });

  it('on →todo with an attributable agent: releases the caller\'s own claim', async () => {
    const f = fakes();
    const out = await releaseTodoClaim({
      status: 'todo',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
    });
    expect(out).toEqual({ claimReleased: true });
    expect(f.calls).toEqual([['ws', 'h', 'plan-a', 'P-001', 'su-x']]);
  });

  it('on →todo with NO caller identity (a human/principal flip): never calls releaseClaim', async () => {
    const f = fakes();
    const out = await releaseTodoClaim({ status: 'todo', agentOwnerId: null, ...at(), releaseClaim: f.releaseClaim });
    expect(out).toEqual({ claimReleased: false });
    expect(f.calls).toHaveLength(0);
  });

  it('on a NON-todo flip (wip/done/blocked/…): never calls releaseClaim — this is todo-specific, not a blanket release', async () => {
    const f = fakes();
    for (const status of ['wip', 'done', 'dropped', 'blocked', 'needs-human']) {
      const out = await releaseTodoClaim({ status, agentOwnerId: 'su-x', ...at(), releaseClaim: f.releaseClaim });
      expect(out).toEqual({ claimReleased: false });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('is fail-safe: a releaseClaim throw is swallowed → claimReleased=false, no throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await releaseTodoClaim({
      status: 'todo',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: async () => {
        throw new Error('coord store down');
      },
    });
    expect(out).toEqual({ claimReleased: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// WI-2156 (completion-integrity, terminal-flip holdership): a done/dropped flip by an
// AGENT who is not the item's live claim holder is refused — the prevention leg the
// close path historically lacked (ornith run-10: a member bulk-flipped items its
// sibling held). These cover the pure decision; the getClaim glue is a thin read.
describe('terminalFlipConflict (WI-2156)', () => {
  const peer: HolderInfo = {
    owner: 'su-peer',
    ownerLabel: 'peer · su-peer',
    intent: 'verifying P-003',
    expiresTs: '2026-07-04T10:00:00Z',
    expired: false,
  };
  it('BLOCKS a terminal flip when a LIVE peer holds the item (returns the holder)', () => {
    const c = terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: peer });
    expect(c).not.toBeNull();
    expect(c?.owner).toBe('su-peer');
    expect(c?.intent).toBe('verifying P-003');
    // dropped is terminal too
    expect(terminalFlipConflict({ status: 'dropped', agentOwnerId: 'su-me', holder: peer })).not.toBeNull();
  });
  it('ALLOWS closing your OWN held item (holder === caller)', () => {
    const mine: HolderInfo = { ...peer, owner: 'su-me', ownerLabel: 'me' };
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: mine })).toBeNull();
  });
  it('ALLOWS when the peer claim is EXPIRED/lapsed (a dead peer never wedges closure)', () => {
    expect(
      terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: { ...peer, expired: true } }),
    ).toBeNull();
  });
  it('ALLOWS a human/principal caller (agentOwnerId null — the guard binds agents, not the owner)', () => {
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: null, holder: peer })).toBeNull();
  });
  it('ALLOWS when the item is unheld (no claim)', () => {
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: null })).toBeNull();
  });
  it('is a NO-OP for non-terminal flips — the wip path owns that claim (no double-guard)', () => {
    expect(terminalFlipConflict({ status: 'wip', agentOwnerId: 'su-me', holder: peer })).toBeNull();
    expect(terminalFlipConflict({ status: 'blocked', agentOwnerId: 'su-me', holder: peer })).toBeNull();
    expect(terminalFlipConflict({ status: 'needs-human', agentOwnerId: 'su-me', holder: peer })).toBeNull();
  });
});

// Guard the status-flip helper the push gate rides on, so a regression in
// the regex (which also feeds importance lookup) trips here.
describe('flipStatusInBody', () => {
  it('flips a status token and reports the old one', () => {
    const body = '- **P-001** `wip` do the thing';
    const out = flipStatusInBody(body, 'P-001', 'needs-human');
    expect(out.found).toBe(true);
    expect(out.oldStatus).toBe('wip');
    expect(out.newBody).toContain('`needs-human`');
  });
});
