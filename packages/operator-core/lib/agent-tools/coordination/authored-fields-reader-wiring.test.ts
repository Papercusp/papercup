/**
 * authored-fields-reader-wiring.test.ts — P-033 (e): the authored message fields
 * actually REACH a reader, at every surface wired to show them.
 *
 * Plan: unified-agent-state-plane-2026-07-27, item P-033 (e). Filed from the
 * WI-6763 audit and built under WI-6768.
 *
 * ⚠ WHY THIS FILE EXISTS AND `message-fields.test.ts` WAS NOT ENOUGH — read this
 * before "simplifying" it into that file, because the gap it covers is the whole
 * point.
 *
 * `projectAuthoredFields` had a thorough, passing unit suite. Its helper feeds the
 * function `stampMessageFields(...)` output directly — the exact flattened shape the
 * send path writes — so the FUNCTION was verified correct and stayed correct.
 *
 * Meanwhile all three call sites wired for P-033 (e) — `coord:read`, `coord:thread`
 * and the pui sync-resolver — passed `envelope.extra`. There is no `extra` key on a
 * stored envelope: `sendCoordMessage` FLATTENS the caller's `extra` onto the envelope
 * (`env[k] = v`, messages.ts), so the fields land at the TOP LEVEL of
 * `coord_event_log.body`. Measured 2026-08-02: of 14,705 messages in 7d, 88 carried
 * top-level `sections` and **0** carried an `extra` key at all. So every one of those
 * calls returned `undefined` on every message, and the feature was dead at 100% of
 * its surfaces while its unit tests were green.
 *
 * A unit test on a pure function cannot catch that — the defect is entirely in the
 * ARGUMENT, one layer up. So this file tests the SEAM instead: the shape a real send
 * produces, fed to the readers, asserted to arrive. Plus a source-level scan, because
 * the cheapest way to reintroduce this is a fourth reader written from the same wrong
 * reading of the parameter.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  stampMessageFields,
  projectAuthoredFields,
  authoredFieldsMarker,
  sectionsToText,
  type MessageSection,
} from './message-fields';

/**
 * Build the envelope a real send produces — flattening the stamp onto it exactly as
 * `sendCoordMessage` does. This is the fixture the old suite lacked: not the stamp in
 * isolation, but the stamp AS IT IS STORED.
 */
function sentEnvelope(sections: MessageSection[], extra: Record<string, unknown> = {}) {
  const stamp = stampMessageFields({ body: sections });
  const env: Record<string, unknown> = {
    kind: 'message',
    msg_id: 'mstest00-0000-0000000000000000000000000000test',
    from: 'su-sender',
    to: ['su-recipient'],
    ts: new Date().toISOString(),
    summary: 'a test message',
    // The text `body` every existing reader renders is the FLATTENED projection.
    body: sectionsToText(sections),
  };
  // The flatten (messages.ts): reserved envelope fields are never clobbered, everything
  // else lands at the top level. This is why `.extra` does not survive a send.
  const RESERVED = new Set(['ts', 'msg_id', 'from', 'to', 'kind']);
  for (const [k, v] of Object.entries({ ...stamp, ...extra })) {
    if (!RESERVED.has(k) && v !== undefined) env[k] = v;
  }
  return env;
}

const AUTHORED_SECTIONS: MessageSection[] = [
  {
    text: 'The gate is red and I think this is why.',
    premises: ['WI-6763#completion', 'unified-agent-state-plane-2026-07-27#D-047'],
    forYouBecause: { relation: 'owns', ref: 'WI-6768' },
    youMayNotKnow: [{ ref: 'msg:msabc', provenance: 'computed' }],
    couldNotDetermine: [{ what: 'whether the deploy carried the fix' }],
  },
  {
    text: 'Second section, different disposition.',
    clarify: [{ question: 'Should I cut the writer?', assuming: 'no — leaving it on' }],
  },
];

describe('P-033 (e) — a sent envelope carries the authored fields where readers look', () => {
  it('stores the authored fields at the TOP LEVEL, and never under `extra`', () => {
    const env = sentEnvelope(AUTHORED_SECTIONS);

    // The positive half: this is where the fields actually are.
    expect(env).toHaveProperty('sections');
    expect(env).toHaveProperty('premisesClassified');

    // The half that would have caught the bug. `extra` is not a key on a stored
    // envelope — asserted rather than commented, because every broken call site was
    // written by someone who reasonably assumed it was.
    expect(env).not.toHaveProperty('extra');
  });

  it('projects from the ENVELOPE — and yields nothing from `.extra`, which is the trap', () => {
    const env = sentEnvelope(AUTHORED_SECTIONS);

    const fromEnvelope = projectAuthoredFields(env);
    expect(fromEnvelope, 'the envelope is the correct argument').toBeDefined();
    expect(fromEnvelope?.sections).toHaveLength(2);

    // Pinned as an explicit expectation: this is what all three readers were doing,
    // and it is indistinguishable from "this message authored nothing" at the reader.
    // If a future refactor ever makes `.extra` meaningful again, this reds and the
    // reader wiring gets revisited deliberately instead of by accident.
    expect(
      projectAuthoredFields((env as { extra?: unknown }).extra),
      '`.extra` is undefined on a stored envelope — passing it silently disables the feature',
    ).toBeUndefined();
  });

  it('surfaces every authored field a reader is meant to see', () => {
    const out = projectAuthoredFields(sentEnvelope(AUTHORED_SECTIONS));
    const first = out?.sections?.[0];

    expect(first?.premises?.map((p) => p.kind)).toEqual([
      'work-item-completion',
      'plan-decision',
    ]);
    expect(first?.forYouBecause?.relation).toBe('owns');
    expect(first?.youMayNotKnow).toHaveLength(1);
    expect(first?.couldNotDetermine?.[0]?.what).toContain('deploy');
    expect(out?.sections?.[1]?.clarify?.[0]?.assuming).toBe('no — leaving it on');
  });

  it('stays silent for an ordinary message, so a plain send grows no new block', () => {
    const plain = sentEnvelope([{ text: 'just a note' }]);
    expect(projectAuthoredFields(plain)).toBeUndefined();
    expect(authoredFieldsMarker(plain)).toBeUndefined();
  });
});

describe('the LIST surfaces get a compact marker, not the full projection', () => {
  it('marks a message that carries authored structure', () => {
    const marker = authoredFieldsMarker(sentEnvelope(AUTHORED_SECTIONS));
    expect(marker).toBeDefined();
    expect(marker).toContain('premises');
    expect(marker).toContain('∵ owns');
    expect(marker).toContain('undetermined');
  });

  it('is bounded — a list row cannot become an envelope dump', () => {
    // The whole reason the list surfaces take the marker: coord:inbox budgets its
    // entries to ~15KB TOTAL and scales the per-entry cap down as `limit` rises, so a
    // full per-section block per row is precisely what that budget exists to prevent.
    const huge: MessageSection[] = Array.from({ length: 20 }, (_, i) => ({
      text: `section ${i} `.repeat(200),
      premises: Array.from({ length: 20 }, (_, j) => `WI-${i}${j}#completion`),
      couldNotDetermine: [{ what: 'x'.repeat(500) }],
    }));
    const marker = authoredFieldsMarker(sentEnvelope(huge))!;
    expect(marker.length).toBeLessThan(400);
    // …while still reporting the real premise count rather than truncating to a lie.
    expect(marker).toContain('400 premises');
  });

  it('is total on junk — a malformed envelope never throws at a reader', () => {
    expect(authoredFieldsMarker(undefined)).toBeUndefined();
    expect(authoredFieldsMarker(null)).toBeUndefined();
    expect(authoredFieldsMarker('nonsense')).toBeUndefined();
    expect(authoredFieldsMarker({ sections: 'not-an-array' })).toBeUndefined();
  });

  it('D-072: a GUI-DERIVED field is never presented as the sender authored it', () => {
    const derived = sentEnvelope(
      [{ text: 'owner GUI message', forYouBecause: { relation: 'owns', ref: 'WI-1' } }],
      { fieldProvenance: { forYouBecause: 'owner-gui' } },
    );
    // The marker must not claim a relation the sender never asserted — that false
    // signal is exactly what the provenance stamp exists to prevent.
    expect(authoredFieldsMarker(derived)).toBeUndefined();
  });
});

/**
 * The recurrence guard for the CLASS, not the instance.
 *
 * The three broken call sites were each written independently, all making the same
 * reading of a parameter that used to be named `extra`. A fourth reader is the obvious
 * way this comes back, and no behavioural test of the three EXISTING readers would
 * notice it. So: scan the source.
 */
describe('no reader may project authored fields off `.extra` (the class guard)', () => {
  const ROOTS = [
    join(__dirname, 'tools'),
    __dirname,
    join(__dirname, '..', '..', 'sync-resolver'),
  ];

  function sourceFiles(dir: string): string[] {
    let out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) continue; // one level: these are flat dirs
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue; // this file pins the trap on purpose
      out.push(full);
    }
    return out;
  }

  it('finds the readers by DISCOVERY, so a new one cannot opt out by being new', () => {
    const callers = ROOTS.flatMap(sourceFiles).filter((f) =>
      /projectAuthoredFields|authoredFieldsMarker/.test(readFileSync(f, 'utf8')),
    );
    // If this ever drops to near-zero the scan has broken (a moved directory), and a
    // silently-empty guard is worse than none — it reports green while checking nothing.
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * `projectAuthoredFields(anything.extra)` / `authoredFieldsMarker(x.extra)`.
   *
   * ⚠ The inner alternation is load-bearing — do NOT simplify it back to `[^)]*`.
   * Two of the three REAL offenders wrote the argument as a cast,
   * `projectAuthoredFields((message as { extra?: unknown }).extra)`, and `[^)]*` stops
   * at the cast's own closing paren, so that pattern matched only the third and would
   * have shipped a guard that reported green against the very code it was written for.
   * (Caught 2026-08-02 by running the pattern against the three real call sites before
   * trusting it — which is why {@link it} below keeps doing exactly that, forever.)
   */
  const PROJECTS_OFF_EXTRA =
    /(?:projectAuthoredFields|authoredFieldsMarker)\s*\((?:[^()]|\([^()]*\))*\.extra\s*\)/;

  it('the pattern actually catches the historical offenders (guard the guard)', () => {
    // The three call sites exactly as they read before the WI-6768 fix. A guard that
    // cannot catch the bug it was written for is worse than no guard: it reports green.
    const historical = [
      'const authored = message ? projectAuthoredFields((message as { extra?: unknown }).extra) : undefined;',
      'const authored = projectAuthoredFields((entry as { extra?: unknown }).extra);',
      'const authored = projectAuthoredFields(body.extra);',
    ];
    for (const line of historical) {
      expect(PROJECTS_OFF_EXTRA.test(line), `should catch: ${line}`).toBe(true);
    }
    // …and does not fire on the corrected forms.
    for (const line of [
      'const authored = message ? projectAuthoredFields(message) : undefined;',
      'const authored = projectAuthoredFields(entry);',
      'const authored = projectAuthoredFields(body);',
      'const authored = authoredFieldsMarker(row);',
    ]) {
      expect(PROJECTS_OFF_EXTRA.test(line), `should NOT fire on: ${line}`).toBe(false);
    }
  });

  it('no call site passes `.extra`', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      if (PROJECTS_OFF_EXTRA.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.replace(/.*packages\//, 'packages/'));
      }
    }
    expect(
      offenders,
      'these readers project off `.extra`, which is undefined on every stored envelope — ' +
        'pass the envelope itself (see projectAuthoredFields)',
    ).toEqual([]);
  });
});
