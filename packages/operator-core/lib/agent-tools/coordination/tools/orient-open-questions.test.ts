/**
 * orient-open-questions.test.ts — WI-5807 (P-007).
 *
 * The fold's whole job is to make an unanswered question VISIBLE to someone who
 * could answer it, because the push path (topic subscriptions) measurably reaches
 * nobody. So these tests pin the properties that decide whether it does that job:
 * self-asked questions never come back to the asker, dead-old ones age out instead
 * of becoming wallpaper, the count stays honest under the cap, and the entries stay
 * small (orient is the hottest read in the system).
 */
import { describe, it, expect } from 'vitest';
import {
  shapeOpenQuestions,
  OPEN_QUESTIONS_CAP,
  OPEN_QUESTIONS_MAX_AGE_DAYS,
} from './orient-open-questions';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    title: 'How does the release gate pick its baseline?',
    asker_id: 'peer-1',
    harness_slug: null,
    created_ts: daysAgo(1),
    ...over,
  };
}

describe('shapeOpenQuestions (WI-5807)', () => {
  it('shapes a compact entry carrying everything needed to answer it', () => {
    const fold = shapeOpenQuestions([row({ harness_slug: 'papercusp', created_ts: daysAgo(3) })], {
      selfOwnerId: 'me',
      nowMs: NOW,
    })!;
    expect(fold.count).toBe(1);
    expect(fold.questions[0]).toEqual({
      id: 'conv-1',
      title: 'How does the release gate pick its baseline?',
      asker: 'peer-1',
      ageDays: 3,
      harness: 'papercusp',
    });
    // The answerer needs the verb, not just the news.
    expect(fold.hint).toContain('conversations:answer');
  });

  it('never shows an agent its OWN unanswered question', () => {
    const fold = shapeOpenQuestions(
      [row({ id: 'mine', asker_id: 'me' }), row({ id: 'theirs', asker_id: 'peer-2' })],
      { selfOwnerId: 'me', nowMs: NOW },
    )!;
    expect(fold.questions.map((q) => q.id)).toEqual(['theirs']);
    expect(fold.count).toBe(1);
  });

  it('returns null (fold ABSENT) when nothing survives the filters', () => {
    expect(shapeOpenQuestions([], { nowMs: NOW })).toBeNull();
    expect(shapeOpenQuestions([row({ asker_id: 'me' })], { selfOwnerId: 'me', nowMs: NOW })).toBeNull();
  });

  it('ages out questions past the max-age cliff so they never become permanent wallpaper', () => {
    const fresh = row({ id: 'fresh', created_ts: daysAgo(OPEN_QUESTIONS_MAX_AGE_DAYS - 1) });
    const stale = row({ id: 'stale', created_ts: daysAgo(OPEN_QUESTIONS_MAX_AGE_DAYS + 1) });
    const fold = shapeOpenQuestions([fresh, stale], { nowMs: NOW })!;
    expect(fold.questions.map((q) => q.id)).toEqual(['fresh']);
    expect(fold.count).toBe(1);
  });

  it('keeps `count` HONEST (the true total) while `questions` stays capped', () => {
    const many = Array.from({ length: OPEN_QUESTIONS_CAP + 4 }, (_, i) =>
      row({ id: `conv-${i}`, created_ts: daysAgo(i) }),
    );
    const fold = shapeOpenQuestions(many, { nowMs: NOW })!;
    expect(fold.count).toBe(OPEN_QUESTIONS_CAP + 4);
    expect(fold.questions).toHaveLength(OPEN_QUESTIONS_CAP);
    // Newest first — an agent should meet the question someone is still waiting on.
    expect(fold.questions.map((q) => q.id)).toEqual(['conv-0', 'conv-1', 'conv-2'].slice(0, OPEN_QUESTIONS_CAP));
    expect(fold.hint).toContain(`${OPEN_QUESTIONS_CAP + 4} open questions`);
  });

  it('orders newest-first even when the caller hands rows in a different order', () => {
    const fold = shapeOpenQuestions(
      [row({ id: 'old', created_ts: daysAgo(9) }), row({ id: 'new', created_ts: daysAgo(1) })],
      { nowMs: NOW },
    )!;
    expect(fold.questions.map((q) => q.id)).toEqual(['new', 'old']);
  });

  it('survives malformed rows instead of throwing (a bad row must not cost the orientation)', () => {
    const fold = shapeOpenQuestions(
      [
        { id: undefined, created_ts: daysAgo(1) }, // no id → skipped
        { id: 'no-date' }, // unparseable created_ts → skipped
        row({ id: 'ok', title: undefined, asker_id: undefined }),
      ],
      { nowMs: NOW },
    )!;
    expect(fold.questions).toEqual([
      { id: 'ok', title: '(untitled)', asker: 'unknown', ageDays: 1 },
    ]);
  });

  it('truncates a runaway title (orient pays for every character)', () => {
    const fold = shapeOpenQuestions([row({ title: 'x'.repeat(500) })], { nowMs: NOW })!;
    expect(fold.questions[0].title.length).toBeLessThanOrEqual(120);
  });

  it('singularizes the hint for exactly one question', () => {
    const fold = shapeOpenQuestions([row()], { nowMs: NOW })!;
    expect(fold.hint).toContain('1 open question has');
    expect(fold.hint).not.toContain('questions has');
  });
});
