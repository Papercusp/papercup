/**
 * `blockedOn` — a structured, checkable blocker on a message section
 * (EI-21548894457555139).
 *
 * The incident behind it: a leader could not tell whether a member was working or
 * wedged. The member knew; the channel had no shape for saying so, so the fact arrived
 * (if at all) as prose a leader cannot act on. These tests pin the two refinements that
 * keep the field from degrading back into prose with a schema around it — a process
 * blocker must carry a handle the reader can check, and the 'other' escape must explain
 * itself.
 */

import { describe, expect, it } from 'vitest';
import {
  messageSectionSchema,
  SECTION_ONLY_FIELDS,
  SECTION_TEXT_MESSAGE,
} from './message-fields';

describe('body section text — actionable validation', () => {
  it.each([
    ['missing', { couldNotDetermine: [{ what: 'whether the next candidate carries the fix' }] }],
    ['wrong-typed', { text: 42 }],
    ['empty', { text: '' }],
  ])('explains how to repair %s section text', (_label, section) => {
    const parsed = messageSectionSchema.safeParse(section);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.find((issue) => issue.path.join('.') === 'text')?.message).toBe(
        SECTION_TEXT_MESSAGE,
      );
    }
  });
});

describe('blockedOn — accepted shapes', () => {
  it('accepts a process blocker carrying a taskId', () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'still running the affected suite',
      blockedOn: {
        kind: 'process',
        taskId: '0mtakpvvk1rxinol1tg',
        logPath: '/tmp/pcv/papercusp-affected-tests/1726252.log',
        startedAt: '2026-08-26T20:55:00.000Z',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a process blocker carrying only a logPath', () => {
    // Either handle is enough: a log path lets the reader judge progress even when the
    // task id was not captured.
    const parsed = messageSectionSchema.safeParse({
      text: 'waiting on the suite',
      blockedOn: { kind: 'process', logPath: '/tmp/run.log' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the non-process kinds with a ref', () => {
    for (const kind of ['event', 'work-item', 'agent', 'owner'] as const) {
      const parsed = messageSectionSchema.safeParse({
        text: 'blocked',
        blockedOn: { kind, ref: 'some-ref' },
      });
      expect(parsed.success, `kind ${kind} should parse`).toBe(true);
    }
  });

  it('is OPTIONAL — a plain { text } section still parses', () => {
    // The field is additive; no existing caller is required to supply it.
    expect(messageSectionSchema.safeParse({ text: 'just a note' }).success).toBe(true);
  });
});

describe('blockedOn — ref is REQUIRED for referenceable kinds (D-003, coord-derived-fields-2026-08-31)', () => {
  // [owner 2026-08-31]: "anything that is a blocker is an important thing, agents might
  // want to await on it being unblocked … they can only do that if it is a real thing
  // not just prose." A ref-less referenceable blocker is neither awaitable nor
  // diffable, so it is refused with the grammar in the message.
  it("REFUSES kind event | work-item | agent | owner with no ref", () => {
    for (const kind of ['event', 'work-item', 'agent', 'owner'] as const) {
      const parsed = messageSectionSchema.safeParse({
        text: 'blocked',
        blockedOn: { kind, note: 'waiting on the thing' },
      });
      expect(parsed.success, `kind ${kind} without ref must refuse`).toBe(false);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => i.message).join('\n');
        expect(msg).toMatch(/REQUIRES `ref`/);
        // The refusal must TEACH the grammar, not just refuse.
        expect(msg).toMatch(/work-item:done:<id>|events:catalog|ownerId/);
      }
    }
  });

  it('the refusal points a truly un-referenceable blocker at the other+note escape', () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'blocked',
      blockedOn: { kind: 'event' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join('\n')).toMatch(/kind:'other'/);
    }
  });
});

describe('blockedOn — refusals that keep it actionable', () => {
  it("REFUSES kind:'process' with neither taskId nor logPath", () => {
    // This is the whole point: a process blocker the reader cannot check leaves them
    // exactly where they were — unable to tell a live run from a wedged one.
    const parsed = messageSectionSchema.safeParse({
      text: 'still running the tests',
      blockedOn: { kind: 'process' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('taskId');
    }
  });

  it("REFUSES kind:'other' with no note", () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'blocked on something',
      blockedOn: { kind: 'other' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('note');
    }
  });

  it("ACCEPTS kind:'other' once it explains itself", () => {
    // Control for the refusal above — the guard must reject the empty escape, not the kind.
    const parsed = messageSectionSchema.safeParse({
      text: 'blocked',
      blockedOn: { kind: 'other', note: 'waiting on a vendor rate-limit window to reset' },
    });
    expect(parsed.success).toBe(true);
  });

  it('REFUSES an unknown kind rather than silently accepting it', () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'blocked',
      blockedOn: { kind: 'vibes' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('blockedOn is section-scoped', () => {
  it('is listed in SECTION_ONLY_FIELDS', () => {
    // Sections carry per-part disposition; the envelope carries whole-message routing.
    // A blocker belongs to the part that is blocked, so it must be refused on the envelope.
    expect(SECTION_ONLY_FIELDS).toContain('blockedOn');
  });
});
