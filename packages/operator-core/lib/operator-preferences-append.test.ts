/**
 * appendPreferenceEntry — same-day-header merge (Gap 7) + the
 * standing_approvals_decide → parseStandingApprovals format round-trip
 * (Gap 12).
 *
 * appendPreferenceEntry reads/writes the markdown body through
 * `operator-state-pg`; we mock it with an in-memory string so the
 * date-section merge logic runs without PG. The date is frozen via
 * vi.setSystemTime so `## <today>` is deterministic.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const NOW = Date.parse('2026-06-16T15:30:00.000Z');
const TODAY = '2026-06-16';

const h = vi.hoisted(() => {
  const state = { content: '' };
  return {
    state,
    readOperatorState: vi.fn(async () => ({ content: state.content })),
    writeOperatorState: vi.fn(async (_key: string, payload: { content: string }) => {
      state.content = payload.content;
    }),
  };
});
vi.mock('./operator-state-pg', () => ({
  readOperatorState: h.readOperatorState,
  writeOperatorState: h.writeOperatorState,
}));

import { appendPreferenceEntry, parseStandingApprovals } from './operator-preferences';

const writeOperatorState = h.writeOperatorState;
const readOperatorState = h.readOperatorState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.content = '';
  readOperatorState.mockClear();
  writeOperatorState.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('appendPreferenceEntry — same-day-header merge (Gap 7)', () => {
  it('creates a `## <today>` section for the first entry of the day', async () => {
    await appendPreferenceEntry('- [USER-TYPED] first note');
    expect(h.state.content).toBe(`## ${TODAY}\n- [USER-TYPED] first note\n`);
  });

  it('appends a second same-day entry UNDER the existing header (no dup header)', async () => {
    await appendPreferenceEntry('- first');
    await appendPreferenceEntry('- second');
    // Exactly one header for today.
    const headerCount = (h.state.content.match(new RegExp(`## ${TODAY}`, 'g')) ?? []).length;
    expect(headerCount).toBe(1);
    expect(h.state.content).toBe(`## ${TODAY}\n- first\n- second\n`);
  });

  it('uses a `\\n\\n` separator before a NEW section only when prior content is non-blank', async () => {
    // Pre-seed an existing section from a different day so today's header is new.
    h.state.content = '## 2026-06-01\n- old note\n';
    await appendPreferenceEntry('- today note');
    expect(h.state.content).toBe(`## 2026-06-01\n- old note\n\n## ${TODAY}\n- today note\n`);
  });

  it('omits the leading separator when existing content is blank', async () => {
    h.state.content = '   \n  \n'; // whitespace-only → existing.trim() falsy
    await appendPreferenceEntry('- note');
    expect(h.state.content).toBe(`## ${TODAY}\n- note\n`);
  });

  it('round-trip: a written STANDING-APPROVE entry re-parses via parseStandingApprovals', async () => {
    const entry =
      `- [OPERATOR-PROPOSED-USER-CONFIRMED-${TODAY}] [STANDING-APPROVE]\n` +
      `  capability=deploy, target=app-a`;
    await appendPreferenceEntry(entry);
    const parsed = parseStandingApprovals(h.state.content);
    expect(parsed).toEqual([
      { confirmedAt: TODAY, capability: 'deploy', targetHarness: 'app-a' },
    ]);
  });
});

describe('standing_approvals_decide entry format round-trips through parser (Gap 12)', () => {
  // Reproduce the EXACT string standing_approvals_decide.ts:37 constructs.
  // (Read-only on the tool — we copy its format here.)
  function decideEntry(capability: string, targetHarness: string): string {
    const today = new Date().toISOString().slice(0, 10);
    return (
      `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n` +
      `  capability=${capability}, target=${targetHarness}\n` +
      `  pattern: ≥3 silent dispatches in 24h\n` +
      `  user confirmed: ${new Date().toISOString()}`
    );
  }

  it('the tool-built entry parses to one StandingApproval with the right fields', () => {
    const entry = decideEntry('send_message', 'sheets');
    const parsed = parseStandingApprovals(entry);
    expect(parsed).toEqual([
      { confirmedAt: TODAY, capability: 'send_message', targetHarness: 'sheets' },
    ]);
  });

  it('adversarial: a capability containing `:` still parses (capability=([^\\s,]+) keeps colons)', () => {
    const entry = decideEntry('secrets:read:OPENAI_KEY', 'vault-h');
    const parsed = parseStandingApprovals(entry);
    expect(parsed).toEqual([
      { confirmedAt: TODAY, capability: 'secrets:read:OPENAI_KEY', targetHarness: 'vault-h' },
    ]);
  });

  it('round-trips end-to-end through appendPreferenceEntry too', async () => {
    await appendPreferenceEntry(decideEntry('deploy', 'prod-app'));
    const parsed = parseStandingApprovals(h.state.content);
    expect(parsed).toEqual([
      { confirmedAt: TODAY, capability: 'deploy', targetHarness: 'prod-app' },
    ]);
  });
});
