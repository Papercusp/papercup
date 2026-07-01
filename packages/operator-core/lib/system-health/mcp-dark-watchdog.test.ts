/**
 * Unit coverage for evaluateMcpDark — the pure "is this bee working MCP-dark?" verdict. The five
 * gates (grace · predates-restart · alive · generating · no-MCP-since-restart) each get a positive
 * and a negative case; the DB wiring (checkMcpDark) is integration-covered. Clock + restartAt are
 * injected so no real time is involved.
 */
import { describe, expect, it } from 'vitest';
import { evaluateMcpDark, type McpDarkSnapshot } from './mcp-dark-watchdog';

const RESTART = 1_000_000_000_000; // fixed operator-boot epoch ms
const M = 60_000;
const NOW = RESTART + 30 * M; // 30 min after the restart — well past the 5-min grace

/** A snapshot that IS dark: started before restart, alive, generating, no MCP since restart. */
function darkSnapshot(over: Partial<McpDarkSnapshot> = {}): McpDarkSnapshot {
  return {
    ownerId: 'role-abc123',
    startedMs: RESTART - 20 * M, // existed before the restart
    supervisorHeartbeatMs: NOW - 1 * M, // supervisor beat 1 min ago ⇒ alive
    lastOutputMs: NOW - 1 * M, // generating output 1 min ago
    presenceHeartbeatMs: RESTART - 5 * M, // last MCP call was BEFORE the restart
    ...over,
  };
}

describe('evaluateMcpDark', () => {
  it('flags a bee that is alive + generating but has made no MCP call since the restart', () => {
    const v = evaluateMcpDark(darkSnapshot(), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('working tool-less (dark)');
  });

  it('treats a NULL presence row (never handshook MCP) as dark', () => {
    const v = evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: null }), RESTART, NOW);
    expect(v.dark).toBe(true);
    expect(v.reason).toContain('never');
  });

  it('does NOT flag within the grace window (client may still be reconnecting)', () => {
    const soon = RESTART + 2 * M; // 2 min in — under the 5-min grace
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon).dark).toBe(false);
  });

  it('does NOT flag a bee spawned AFTER the restart (just booting, not a failed reconnect)', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: RESTART + 1 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee with no started_at recorded', () => {
    expect(evaluateMcpDark(darkSnapshot({ startedMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag when the supervisor beat is stale (process likely gone, not dark)', () => {
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ supervisorHeartbeatMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag an idle bee (no recent output — not a live turn needing tools)', () => {
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: NOW - 10 * M }), RESTART, NOW).dark).toBe(false);
    expect(evaluateMcpDark(darkSnapshot({ lastOutputMs: null }), RESTART, NOW).dark).toBe(false);
  });

  it('does NOT flag a bee that HAS reconnected (presence heartbeat advanced past the restart)', () => {
    expect(evaluateMcpDark(darkSnapshot({ presenceHeartbeatMs: RESTART + 3 * M }), RESTART, NOW).dark).toBe(false);
  });

  it('respects custom thresholds (tighter grace flips a borderline case to dark)', () => {
    const soon = RESTART + 2 * M;
    // default 5-min grace ⇒ not dark; a 1-min grace ⇒ dark (all other gates hold).
    expect(evaluateMcpDark(darkSnapshot(), RESTART, soon, { graceMs: 1 * M }).dark).toBe(true);
  });
});
