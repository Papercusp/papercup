import { describe, it, expect } from 'vitest';
import { matchRoutingGateHint, renderRoutingGateHintLine, ROUTING_GATE_ROWS } from './routing-gate-hints';

describe('matchRoutingGateHint', () => {
  it('matches a title with both a schedule action and cadence', () => {
    const hit = matchRoutingGateHint('Schedule and send a daily 9am digest of open items');
    expect(hit?.row).toBe('schedule-recurrence');
    expect(hit?.mechanism).toContain('plans:set-schedule');
  });

  it('matches a watch/alert phrasing in the owner-authored title', () => {
    const hit = matchRoutingGateHint('Alert me when the release gate goes red');
    expect(hit?.row).toBe('watch-alert');
    expect(hit?.mechanism).toBe('watch:create');
  });

  it('matches a create-app title', () => {
    const hit = matchRoutingGateHint('Create a web app for fleet status');
    expect(hit?.row).toBe('create-app');
  });

  it('matches a credential/API-key owner-authored title', () => {
    const hit = matchRoutingGateHint("Use this API key for the provider");
    expect(hit?.row).toBe('credential-key');
  });

  it('matches a bring-repo-under-management title', () => {
    const hit = matchRoutingGateHint('Bring this repo under management');
    expect(hit?.row).toBe('bring-repo-under-management');
  });

  it('matches a design-screen title', () => {
    const hit = matchRoutingGateHint('Design this screen for the settings panel');
    expect(hit?.row).toBe('design-screen');
  });

  it('returns null for unrelated text', () => {
    expect(matchRoutingGateHint('Fix the merge cursor off-by-one')).toBeNull();
  });

  it('does not infer routing from arbitrary body prose such as recurrence guard', () => {
    expect(matchRoutingGateHint('Fix parser quoting')).toBeNull();
    expect(matchRoutingGateHint('Add a recurrence guard test')).toBeNull();
  });

  it('requires both an action and cadence for inferred scheduling', () => {
    expect(matchRoutingGateHint('Daily digest report')).toBeNull();
    expect(matchRoutingGateHint('Schedule the digest report')).toBeNull();
    expect(matchRoutingGateHint('Schedule the digest report daily')?.row).toBe('schedule-recurrence');
  });

  it('supports deterministic typed owner intent and requires cadence for schedule intent', () => {
    expect(matchRoutingGateHint('Digest', { ownerIntent: 'schedule-recurrence' })).toBeNull();
    expect(matchRoutingGateHint('Digest', { ownerIntent: 'schedule-recurrence', cadence: 'daily at 09:00' }))
      .toMatchObject({ row: 'schedule-recurrence', matchedOn: 'ownerIntent+cadence:daily at 09:00' });
    expect(matchRoutingGateHint('Generic task', { ownerIntent: 'watch-alert' })?.row).toBe('watch-alert');
  });

  it('returns null for empty/blank input', () => {
    expect(matchRoutingGateHint('')).toBeNull();
    expect(matchRoutingGateHint(null)).toBeNull();
    expect(matchRoutingGateHint('   ')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchRoutingGateHint('ALERT ME WHEN THE BUILD FAILS')?.row).toBe('watch-alert');
  });

  it('checks rows in declaration order and every row is independently reachable', () => {
    // Guards against a future row whose keywords are unreachable (shadowed by an
    // earlier row's broader keyword set) — every row's own first keyword must
    // resolve back to that row.
    for (const row of ROUTING_GATE_ROWS) {
      const hit = row.id === 'schedule-recurrence'
        ? matchRoutingGateHint(`schedule this ${row.keywords[0]}`)
        : matchRoutingGateHint(row.keywords[0]);
      expect(hit?.row).toBe(row.id);
    }
  });

  it('renderRoutingGateHintLine renders a one-line brief', () => {
    const hit = matchRoutingGateHint('Alert me when the gate is red');
    expect(hit).not.toBeNull();
    const line = renderRoutingGateHintLine(hit!);
    expect(line).toMatch(/^papercusp way: watch:create/);
  });
});
