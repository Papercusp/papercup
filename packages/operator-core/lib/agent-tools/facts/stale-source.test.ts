/**
 * EI-10947 — a fact anchored to a CLOSED work-item must be flagged, not silently folded
 * as a live imperative.
 *
 * The failure being guarded: `ei-10539-dist-atomic-swap-in-progress` (body: "... NEXT:
 * implement EI-10539", sourceRef wi:EI-10539) kept folding verbatim into every orient
 * AFTER EI-10539 was completed — an instruction to redo finished work, delivered as
 * binding context.
 */
import { describe, expect, it } from 'vitest';
import { parseStateFromLabel, isTerminalLabel, TERMINAL_ITEM_STATES } from './stale-source';

describe('parseStateFromLabel (EI-10947)', () => {
  it('pulls the state out of the hydrateRefs `kind/state` label shape', () => {
    expect(parseStateFromLabel('EI-10539 [bug/resolved]')).toBe('resolved');
    expect(parseStateFromLabel('WI-4172 [feature/wip]')).toBe('wip');
    expect(parseStateFromLabel('F-021 [feature/done]')).toBe('done');
  });

  it('handles a bare-state bracket group (no kind prefix)', () => {
    expect(parseStateFromLabel('WI-1 [open]')).toBe('open');
  });

  it('is case-insensitive on the state', () => {
    expect(parseStateFromLabel('EI-9 [bug/RESOLVED]')).toBe('resolved');
  });

  it('returns null for a label with no bracket group, and for undefined', () => {
    expect(parseStateFromLabel('EI-10539')).toBeNull();
    expect(parseStateFromLabel(undefined)).toBeNull();
    expect(parseStateFromLabel('')).toBeNull();
  });
});

describe('isTerminalLabel (EI-10947)', () => {
  it('flags the closed states — these are the ones that strand a carry-note', () => {
    expect(isTerminalLabel('EI-10539 [bug/resolved]')).toBe(true);
    expect(isTerminalLabel('WI-1 [task/done]')).toBe(true);
    expect(isTerminalLabel('WI-2 [bug/deprecated]')).toBe(true);
    expect(isTerminalLabel('WI-3 [task/wont_do]')).toBe(true);
  });

  it('does NOT flag a still-open item — an in-flight carry-note is exactly what facts are for', () => {
    expect(isTerminalLabel('WI-4172 [feature/wip]')).toBe(false);
    expect(isTerminalLabel('WI-5 [bug/open]')).toBe(false);
    expect(isTerminalLabel('WI-6 [task/todo]')).toBe(false);
    expect(isTerminalLabel('WI-7 [feature/blocked]')).toBe(false);
  });

  it('does not flag an unparseable label rather than guessing (fail-soft)', () => {
    expect(isTerminalLabel('EI-10539')).toBe(false);
    expect(isTerminalLabel(undefined)).toBe(false);
  });

  it('treats an unknown state as NOT terminal — a false "stale" flag on a live fact would be its own bug', () => {
    expect(isTerminalLabel('WI-8 [bug/some-new-state]')).toBe(false);
    expect(TERMINAL_ITEM_STATES.has('some-new-state')).toBe(false);
  });
});
