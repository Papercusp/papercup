/**
 * P-014 architecture guard — one liveness verdict, explicit orthogonal signals.
 *
 * `sessionState` from resolveSessionStates is the verdict. Heartbeat age is a
 * compatibility/display tone; transcript mtime is output freshness. These
 * source guards make the boundary fail closed at the exact UI seams that used
 * to promote those weaker signals back into verdicts.
 *
 * Run:
 *   cd packages/operator-core
 *   npx vitest run lib/fleet/liveness-verdict-boundary.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

const SESSIONS_ROSTER = 'apps/operator/app/adv/sessions/SessionsRosterView.tsx';
const HUD_MODEL = 'apps/operator/app/adv/hud/hud-board-model.ts';
const RUNNING_PILL = 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx';
const ADV_ROSTER = 'packages/operator-core/lib/adv-roster.ts';
const HEARTBEAT_TONE = 'packages/operator-core/lib/liveness.ts';
const PRESENCE_UI = 'apps/operator/app/coord/presence-ui.tsx';

describe('agent-liveness verdict boundary (presence unification D-004 / P-014)', () => {
  it('routes every SessionsRosterView decision through sessionState first', () => {
    const text = source(SESSIONS_ROSTER);

    expect(text).toContain('const sessionState = normalizeSessionState(e.sessionState)');
    expect(text).toContain('return sessionState ? livenessForSessionState(sessionState) : e.liveness');
    expect(text).toContain("const heartbeatFresh = e.heartbeatFresh ?? e.liveness !== 'stale'");

    // The two reads above are the complete compatibility boundary: one old-payload
    // display fallback and one old-payload heartbeatFresh fallback. A third raw read
    // means a count/filter/hiding/render decision bypassed the oracle projection.
    expect(countMatches(text, /\be\.liveness\b/g)).toBe(2);
    expect(text).not.toMatch(/filter\(\(e\) => e\.liveness/);
    expect(text).not.toMatch(/<LivenessDot\s+liveness=\{e\.liveness\}/);
  });

  it('keeps transcript freshness subordinate to an unavailable oracle verdict in HUD', () => {
    const text = source(HUD_MODEL);

    expect(text).toContain('const transcriptFresh = e.transcriptFresh ?? e.thinking');
    expect(text).toMatch(
      /e\.sessionState == null\s*&&\s*e\.liveTurn == null\s*&&\s*transcriptFresh/,
    );
    expect(countMatches(text, /\be\.thinking\b/g)).toBe(1);
    expect(text).not.toMatch(/oracleWorking\s*\|\|\s*e\.(?:thinking|transcriptFresh)/);
  });

  it('publishes transcriptFresh canonically and confines the thinking alias to skew shims', () => {
    const server = source(ADV_ROSTER);
    const pill = source(RUNNING_PILL);

    expect(server).toMatch(/transcriptFresh:\s*boolean/);
    expect(server).toMatch(/@deprecated Compatibility alias for `transcriptFresh`[\s\S]{0,180}thinking:\s*boolean/);
    expect(server).toContain('resolveTranscriptFreshnessForEntries');

    expect(pill).toMatch(/transcriptFresh\?:\s*boolean \| null/);
    expect(pill).toContain('return a.transcriptFresh ?? a.thinking ?? false');
    expect(countMatches(pill, /\ba\.thinking\b/g)).toBe(1);
  });

  it('marks heartbeat-only derivations as deprecated display fallbacks', () => {
    const core = source(HEARTBEAT_TONE);
    const client = source(PRESENCE_UI);

    expect(core).toContain('export function heartbeatAgeTone');
    expect(core).toMatch(/@deprecated[\s\S]{0,300}export function deriveLiveness/);
    expect(client).toContain('export function heartbeatToneFromTimestamp');
    expect(client).toMatch(/@deprecated[\s\S]{0,400}export function livenessFromHeartbeat/);
  });
});
