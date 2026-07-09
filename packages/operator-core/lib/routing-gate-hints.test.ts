import { describe, it, expect } from 'vitest';
import { matchRoutingGateHint, renderRoutingGateHintLine, ROUTING_GATE_ROWS } from './routing-gate-hints';

describe('matchRoutingGateHint', () => {
  it('matches a schedule/recurrence title', () => {
    const hit = matchRoutingGateHint('Send a daily 9am digest of open items');
    expect(hit?.row).toBe('schedule-recurrence');
    expect(hit?.mechanism).toContain('plans:set-schedule');
  });

  it('matches a watch/alert phrasing in the summary', () => {
    const hit = matchRoutingGateHint('Gate health', 'Alert me when the release gate goes red');
    expect(hit?.row).toBe('watch-alert');
    expect(hit?.mechanism).toBe('watch:create');
  });

  it('matches a create-app title', () => {
    const hit = matchRoutingGateHint('Create a web app for fleet status');
    expect(hit?.row).toBe('create-app');
  });

  it('matches a credential/API-key summary', () => {
    const hit = matchRoutingGateHint('Wire up billing', "Here's my API key for the provider");
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
    expect(matchRoutingGateHint('Fix the merge cursor off-by-one', 'unrelated body text')).toBeNull();
  });

  it('returns null for empty/blank input', () => {
    expect(matchRoutingGateHint('')).toBeNull();
    expect(matchRoutingGateHint(null, undefined)).toBeNull();
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
      const hit = matchRoutingGateHint(row.keywords[0]);
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
