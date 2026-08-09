/**
 * P-006 / D-031 — the observation population has ONE identity: the `lane` column.
 *
 * Plan learning-loop-identity-and-consumption-2026-08-08, decision D-031.
 *
 * WHAT WENT WRONG. Two definitions of "the observation lane" were in use, in OPPOSITE
 * directions, so every disagreement between them was a hole:
 *
 *   EXCLUSION  `lane IS DISTINCT FROM 'observation'`   (keeps observations OUT of the
 *              claim/triage queue — D-005)
 *   INCLUSION  a `coord_links` topic-tag join, fenced to `coordScopeWorkspace()`
 *              (reads the observation corpus)
 *
 * Measured live 2026-08-09 (papercusp-workspace): 15,875 rows by lane vs 15,074 by the
 * topic join as the reader actually runs it — a symmetric difference of 834, running
 * BOTH ways. 471 lane rows carried no tag edge at all; 330 had one filed under the
 * legacy `workspace_id='default'`; and 33 were tagged with `lane` NULL — 6 of those
 * OPEN `bug` rows sitting in the triage queue, which is precisely what D-005 forbids.
 *
 * WHY THIS GUARD IS NOT THE ONE P-006 ASKED FOR. P-006's stated acceptance was "an
 * anti-drift test asserts the two definitions return identical row sets". D-031 §4
 * rejects that: it asserts a property of LIVE DATA inside the fleet's green gate, so it
 * reds on an operational condition rather than a code defect, and it would red again
 * the next time the still-open workspace-scope split (EI-2760 / WI-4308) mints one
 * mis-scoped edge — a fleet-wide landmine for a condition no code change caused. This
 * guard binds the thing P-006 actually cares about instead: that the READERS agree on
 * one identity. It is deterministic and needs no database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ListIssuesFilter } from '../../issues-engineer';
import {
  OBSERVATION_LANE,
  OBSERVATION_TOPIC,
  countObservationFilingsSince,
  readObservationItems,
} from './read-items';

describe('observation reads select by LANE, never by the topic join (P-006/D-031)', () => {
  it('readObservationItems filters on lane and passes NO topic', async () => {
    const seen: ListIssuesFilter[] = [];
    await readObservationItems(
      {},
      {
        listIssues: async (filter) => {
          seen.push(filter);
          return [];
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.lane).toBe(OBSERVATION_LANE);
    // The important half: asserting `lane` is set would still pass if `topic` were
    // ALSO sent, and the topic leg is the lossy one — it would keep narrowing the read.
    expect(seen[0]?.topic).toBeUndefined();
  });

  it('countObservationFilingsSince filters on lane and passes NO topic', async () => {
    const seen: ListIssuesFilter[] = [];
    await countObservationFilingsSince('agent-x', null, {
      countIssues: async (filter) => {
        seen.push(filter);
        return 0;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.lane).toBe(OBSERVATION_LANE);
    expect(seen[0]?.topic).toBeUndefined();
  });

  it('the list and its COUNT companion select the same population', async () => {
    // These two are paired at every call site to render "N of TOTAL". If they ever
    // select differently the UI reports a total for a set it is not showing.
    const listFilters: ListIssuesFilter[] = [];
    const countFilters: ListIssuesFilter[] = [];
    await readObservationItems(
      {},
      {
        listIssues: async (f) => {
          listFilters.push(f);
          return [];
        },
      },
    );
    await countObservationFilingsSince('agent-x', null, {
      countIssues: async (f) => {
        countFilters.push(f);
        return 0;
      },
    });
    expect(listFilters[0]?.lane).toBe(countFilters[0]?.lane);
  });

  it('the two constants stay distinct — the tag is a LABEL, the lane is the IDENTITY', () => {
    // Capture still writes the topic tag; nothing about D-031 removes it. This pins
    // that they are different things, so a later "simplification" cannot quietly
    // collapse the label back into the identity.
    expect(OBSERVATION_LANE).not.toBe(OBSERVATION_TOPIC);
    expect(OBSERVATION_LANE).toBe('observation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-level anti-drift scan.
//
// Anchored to the PROPERTY that defines the defect — selecting the observation
// population through the workspace-fenced topic join — not to any one spelling of it.
// Both the constant and its literal value are matched, because a future caller can
// reach the same population either way, and a detector that only knew the constant
// would report clean against an inlined string (the form-blind-detector trap in
// CLAUDE.md, which has already corrected the same population count three times).

/** Overridable so falsifiability can be probed against a COPY, outside the shared
 *  tree — never by mutating these files in place (CLAUDE.md's mutation-probe rule). */
const guardRoot = process.env.PAPERCUSP_OBS_LANE_GUARD_ROOT
  ? resolve(process.env.PAPERCUSP_OBS_LANE_GUARD_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A read filter that selects the observation population by TOPIC. Tolerates
 *  whitespace and both the constant and the inlined slug. */
const TOPIC_SELECT =
  /\btopic\s*:\s*(OBSERVATION_TOPIC\b|['"`]papercusp-observation['"`])/;

const findTopicSelects = (source: string): string[] =>
  source
    .split(/\n/)
    .flatMap((line, i) => (TOPIC_SELECT.test(line) ? [`${i + 1}: ${line.trim()}`] : []));

describe('no reader reaches the observation population through the topic join', () => {
  it('CONTROL: the detector FIRES on the anti-pattern (proves it can fail)', () => {
    // Deliberately-wrong samples kept permanently here, so this guard is never a check
    // that has only ever been observed passing.
    expect(findTopicSelects('  const filter = { topic: OBSERVATION_TOPIC, state: "open" };')).toHaveLength(1);
    expect(findTopicSelects("await listIssues({ topic: 'papercusp-observation', limit: 500 })")).toHaveLength(1);
    expect(findTopicSelects('{ topic:   OBSERVATION_TOPIC }')).toHaveLength(1);

    // CALIBRATION: it must NOT fire on the things that are still correct — selecting
    // the IMPROVEMENT population by topic (unchanged by D-031), writing the tag on
    // capture, or selecting observations the new way.
    expect(findTopicSelects('{ topic: IMPROVEMENT_TOPIC, state }')).toEqual([]);
    expect(findTopicSelects('const baseTopic = isObservation ? OBSERVATION_TOPIC : IMPROVEMENT_TOPIC;')).toEqual([]);
    expect(findTopicSelects('{ lane: OBSERVATION_LANE, state }')).toEqual([]);
    expect(findTopicSelects('topics: [OBSERVATION_TOPIC],')).toEqual([]);
  });

  it('no improvements-lane module selects observations by topic', () => {
    const dir = resolve(guardRoot, 'harness/improvements');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.includes('.test.')) continue;
      const hits = findTopicSelects(readFileSync(resolve(dir, f), 'utf8'));
      if (hits.length) offenders.push(`${f} → ${hits.join('; ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the sync-resolver and system-health readers select observations by lane', () => {
    // The three reads outside the improvements lane that used to carry the topic
    // filter. Named explicitly: a directory sweep here would silently stop covering
    // them if a file were renamed or moved.
    const files = [
      'sync-resolver/learning-observations-read.ts',
      'sync-resolver/index.ts',
      'system-health/compute.ts',
    ];
    const offenders: string[] = [];
    for (const rel of files) {
      const hits = findTopicSelects(readFileSync(resolve(guardRoot, rel), 'utf8'));
      if (hits.length) offenders.push(`${rel} → ${hits.join('; ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
