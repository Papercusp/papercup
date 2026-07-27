/**
 * message-sender-completeness.test.ts — P-014: every writer to the coord
 * `messages` surface is DISCOVERED (never hand-listed), and each one produces an
 * envelope that satisfies the wire contract.
 *
 * Plan: agent-state-plane-verification-2026-07-27, item P-014, built to ruling
 * **D-011** on that plan. Read D-011 before changing this file — it records why
 * the item's first sentence is refuted and this file asserts something else.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES NOT ASSERT. P-014 as written asks to "assert
 * every non-agent sender produces `body: Section[]`, not a bare string."
 * Measured against production first, that premise does not hold and building to
 * it would encode the OPPOSITE of the shipped design:
 *   · `CoordEnvelope.body` is declared `body?: string` — a Section[] body is not
 *     representable on the wire at all. Sections ride BESIDE the text as
 *     `sections`; `sectionsToText` produces the `body` string (send.ts).
 *   · a plain-string send deliberately stamps NO `sections` ("the n=1 case costs
 *     nothing" — send.ts), which is why 1 of 68,202 stored messages carries the
 *     field. That is design, not breakage.
 *   · `owner-message.ts` deliberately refuses to invent section content for a
 *     non-agent sender (D-064/D-070/D-072); fabricating it would produce exactly
 *     the healthy-looking empty schema those rulings exist to prevent.
 * Body-as-array was refused ONCE, ever. So the Section[] clause is encoded below
 * as a REFUTATION pinned against the type, not silently dropped.
 *
 * ⚠ WHY DISCOVERY, AND WHY THE PREDICATE IS A UNION. The item's real content is
 * its second sentence: "a test that checks only the senders someone remembered
 * is how the last one gets missed." That is not hypothetical here — the obvious
 * predicate (`appendLine('messages', …)`) MISSES `insertFanoutNotify`, which
 * writes the same surface through a raw idempotent INSERT. A hand-written list,
 * or a single-pattern scan, would have shipped green while leaving a real sender
 * unguarded. The scan below is therefore a UNION of the three ways this surface
 * is actually written, and it fails on a sender it does not recognise.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { toSections, sectionsToText } from './message-fields';
import { ownerMessageDefaults, OWNER_FIELD_PROVENANCE } from './owner-message';

/** Strip comments so a structural scan reads CODE, not prose. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** `packages/operator-core/lib` — the production tree that owns this surface. */
const LIB_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The three ways the coord `messages` surface is actually written. A union, not
 * a single pattern: `appendLine` alone misses the raw-INSERT fan-out path, and
 * missing a writer is the exact failure this item names.
 */
const WRITES_MESSAGES_SURFACE: RegExp[] = [
  /appendLine\(\s*['"]messages['"]/, // the coord-log writers
  /INSERT INTO harness_shared\.coord_event_log[\s\S]{0,400}?['"]messages['"]/, // the idempotent fan-out insert
  /buildInjectEnvelope\s*\(/, // producers of a notify envelope for that surface
];

/**
 * The senders this suite has actually reviewed. Pinned BOTH ways below: a new
 * writer that is absent here reds (it shipped unguarded), and a name here that
 * no longer writes the surface reds (the pin went stale). Paths are relative to
 * `packages/operator-core/lib`.
 */
const KNOWN_SENDERS = [
  'agent-tools/coordination/fanout-delivery.ts',
  'agent-tools/coordination/messages.ts',
  'operator-hindsight.ts',
  'sync/hyperbee/fanout-projection.ts',
] as const;

/** Envelope fields `CoordEnvelope` declares NON-optional — the wire contract. */
const REQUIRED_ENVELOPE_FIELDS = ['ts', 'msg_id', 'from', 'to', 'kind'] as const;

function discoverSenders(): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const rel of readdirSync(LIB_DIR, { recursive: true, encoding: 'utf8' })) {
    const path = rel.split('\\').join('/');
    if (!path.endsWith('.ts') || path.endsWith('.d.ts')) continue;
    if (path.includes('.test.') || path.includes('__tests__/')) continue;
    let text: string;
    try {
      text = codeOnly(readFileSync(join(LIB_DIR, path), 'utf8'));
    } catch {
      continue;
    }
    if (WRITES_MESSAGES_SURFACE.some((re) => re.test(text))) out.push([path, text] as const);
  }
  return out;
}

const senders = discoverSenders();

describe('P-014 — the coord `messages` sender population is DISCOVERED and COMPLETE', () => {
  it('is non-vacuous: the scan read real code and found the surface writers', () => {
    // The corpus floor. A predicate that stops matching (a rename, a refactor to
    // a helper) would otherwise empty this list and turn every assertion in this
    // file into a green no-op — which is the failure mode the item warns about.
    expect(senders.length).toBeGreaterThanOrEqual(KNOWN_SENDERS.length);
    for (const [path, text] of senders) {
      expect(text.length, `${path} scanned as empty`).toBeGreaterThan(200);
    }
  });

  it('every DISCOVERED sender is one this suite has reviewed — a new one must not ship unguarded', () => {
    const unreviewed = senders.map(([p]) => p).filter((p) => !KNOWN_SENDERS.includes(p as never));
    expect(
      unreviewed,
      `a NEW writer to the coord 'messages' surface appeared. Review its envelope, then add it to KNOWN_SENDERS. This is the "last one gets missed" failure P-014 exists to catch.`,
    ).toEqual([]);
  });

  it('every REVIEWED sender still writes the surface — the pin cannot go stale', () => {
    const found = senders.map(([p]) => p);
    const vanished = KNOWN_SENDERS.filter((p) => !found.includes(p));
    expect(
      vanished,
      'KNOWN_SENDERS names a file that no longer writes the messages surface — remove it rather than leaving a dead pin that weakens the floor',
    ).toEqual([]);
  });

  it('the raw-INSERT fan-out path is in the corpus — proving the union predicate earns its keep', () => {
    // Guards the predicate itself. `insertFanoutNotify` writes surface='messages'
    // WITHOUT appendLine, so an appendLine-only scan reports a clean, complete,
    // and wrong answer. If this ever drops out, the scan silently narrowed.
    expect(senders.map(([p]) => p)).toContain('sync/hyperbee/fanout-projection.ts');
  });

  it('every sender either BUILDS a complete envelope or DELEGATES to the shared builder', () => {
    // Structural because these writers open PG; the behavioural counterpart for
    // the shared builder is asserted for real below.
    //
    // Delegation is the correct shape, not a gap: `insertFanoutNotify` calls
    // `buildInjectEnvelope` precisely so an injected notice is identical however
    // it was delivered. What must never happen is a writer that does NEITHER —
    // hand-rolling a partial envelope onto the surface.
    for (const [path, text] of senders) {
      const delegates = /buildInjectEnvelope\s*\(/.test(text);
      const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(text));
      expect(
        delegates || missing.length === 0,
        `${path} neither delegates to a shared envelope builder nor names required field(s): ${missing.join(', ')}`,
      ).toBe(true);
    }
  });

  it('the shared builder REALLY produces every required field — the known-positive behind the delegation', async () => {
    // Without this the delegation branch above would be an escape hatch: a writer
    // could satisfy it by calling a builder that itself emits a partial envelope.
    const { buildInjectEnvelope } = await import('./fanout-delivery');
    const env = buildInjectEnvelope(
      { subscriber_id: 'su-peer', delivery_mode: 'all', via: 'topic:gate-dx' } as never,
      { from: 'su-sender', summary: 'a thing happened', notify_kind: 'topic', subject: 'gate-dx' } as never,
    ) as unknown as Record<string, unknown>;

    for (const field of REQUIRED_ENVELOPE_FIELDS) {
      expect(env[field], `buildInjectEnvelope omitted required field \`${field}\``).toBeDefined();
    }
    expect(typeof env.ts).toBe('string');
    expect(typeof env.msg_id).toBe('string');
    expect(env.to).toEqual(['su-peer']);
    // And the wire body stays a STRING when present — never a Section[] (D-011).
    expect(['string', 'undefined']).toContain(typeof env.body);
  });
});

describe('P-014 — the envelope body is a STRING (D-011: the Section[] premise, refuted and pinned)', () => {
  const envelopeSrc = codeOnly(
    readFileSync(
      new URL('../../../../../libs/generic/pubsub-substrate/src/core/envelope.ts', import.meta.url),
      'utf8',
    ),
  );

  it('is non-vacuous: the envelope type module was actually read', () => {
    expect(envelopeSrc).toContain('interface CoordEnvelope');
    expect(envelopeSrc.length).toBeGreaterThan(500);
  });

  it('CoordEnvelope declares `body?: string` — a Section[] body is not representable on the wire', () => {
    // This is D-011 encoded. If someone later "fixes" P-014 by widening the wire
    // body to an array, this reds and points at the ruling instead of letting a
    // refuted premise quietly become the design.
    expect(envelopeSrc).toMatch(/\bbody\?:\s*string\b/);
    expect(envelopeSrc).not.toMatch(/\bbody\?:\s*[A-Za-z]*Section\[\]/);
  });

  it('a bare string is the n=1 section case, and flattens back to exactly itself', () => {
    // Why no sender needs to "produce Section[]": every reader already sees one
    // shape because the string IS a one-section message.
    expect(toSections('just text')).toEqual([{ text: 'just text' }]);
    expect(sectionsToText(toSections('just text'))).toBe('just text');
    expect(toSections(undefined)).toEqual([]);
    expect(toSections('')).toEqual([]);
  });
});

describe('P-014 — a non-agent sender STAMPS what it derived (D-070 / D-072)', () => {
  /**
   * The half that makes the non-agent path honest. A GUI cannot author protocol
   * fields, so the wrapper derives them — and every derived field must be marked,
   * or the D-070 adoption measurement counts machine defaults as sender intent.
   * That inflation is the P-029 failure this stamp exists to prevent.
   */
  it('marks EVERY field it derived, and marks nothing it did not', () => {
    const d = ownerMessageDefaults({ to: ['su-peer'], summary: 'hi', body: 'hello' });

    expect(Object.keys(d.fieldProvenance).length).toBeGreaterThan(0);
    for (const [field, mark] of Object.entries(d.fieldProvenance)) {
      expect(mark, `${field} stamped with an unexpected provenance`).toBe(OWNER_FIELD_PROVENANCE);
      expect(
        (d as unknown as Record<string, unknown>)[field],
        `${field} is stamped as derived but carries no value`,
      ).toBeDefined();
    }
  });

  it('never invents the fields a GUI cannot honestly answer', () => {
    // owner-message.ts: "POPULATE ONLY WHAT CAN BE POPULATED HONESTLY." A goal
    // ref, a reasoning chain and a read-trace have no GUI equivalent, and
    // plausible values for them are worse than absent ones.
    const d = ownerMessageDefaults({ to: ['su-peer'], summary: 'hi' }) as unknown as Record<string, unknown>;
    for (const field of ['why', 'premises', 'youMayNotKnow', 'couldNotDetermine', 'basedOn']) {
      expect(d[field], `the owner wrapper invented \`${field}\``).toBeUndefined();
      expect(
        (d.fieldProvenance as Record<string, unknown>)[field],
        `the owner wrapper stamped \`${field}\` it never filled`,
      ).toBeUndefined();
    }
  });

  it('an explicitly authored value is NOT overwritten and NOT stamped as derived', () => {
    // The stamp must mean "we filled this", not "this message came from a GUI" —
    // otherwise a human who did state their intent gets it discounted.
    const d = ownerMessageDefaults({ to: ['su-peer'], summary: 'hi', expects: 'action' });
    expect(d.expects).toBe('action');
    expect(d.fieldProvenance.expects).toBeUndefined();
  });
});
