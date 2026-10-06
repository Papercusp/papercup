/**
 * The "looks like a bug" classifier is measured before it may suggest by default
 * (slack-messages-to-bug-reports-2026-10-05 P-007, D-010).
 *
 * The holdout (fixtures/chat-bug-suggest-holdout.json) was written before the classifier and is
 * never used for tuning. Its bars were fixed before the first holdout run: precision >= 0.9 (a
 * false positive is a private note to someone who was not reporting anything) and recall >= 0.6
 * (below that the feature reminds too rarely to be worth switching on).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_BUG_CLASSIFIER_VERSION,
  CHAT_BUG_SUGGEST_THRESHOLD,
  scoreChatBugLikelihood,
} from './chat-bug-suggest';

interface Labelled {
  bug: boolean;
  text: string;
}

function sample(name: string): Labelled[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { messages: Labelled[] }).messages;
}

function measure(messages: Labelled[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const falsePositives: string[] = [];
  for (const message of messages) {
    const predicted = scoreChatBugLikelihood(message.text).suggest;
    if (predicted && message.bug) tp += 1;
    else if (predicted) {
      fp += 1;
      falsePositives.push(message.text);
    } else if (message.bug) fn += 1;
    else tn += 1;
  }
  return { tp, fp, fn, tn, precision: tp / (tp + fp), recall: tp / (tp + fn), falsePositives };
}

describe('chat bug suggestion classifier', () => {
  it('meets the precision and recall bars on the frozen holdout', () => {
    const holdout = sample('chat-bug-suggest-holdout.json');
    // The sample itself is non-trivial: both classes are well represented.
    expect(holdout.filter((m) => m.bug).length).toBeGreaterThanOrEqual(30);
    expect(holdout.filter((m) => !m.bug).length).toBeGreaterThanOrEqual(30);
    const result = measure(holdout);
    // Surfaced in the run log so the measured numbers are on record, not just the pass.
    console.info(`chat-bug-suggest holdout ${CHAT_BUG_CLASSIFIER_VERSION}`, JSON.stringify(result));
    expect(result.precision).toBeGreaterThanOrEqual(0.9);
    expect(result.recall).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps the tuning sample at full precision', () => {
    const result = measure(sample('chat-bug-suggest-tuning.json'));
    expect(result.falsePositives).toEqual([]);
    expect(result.recall).toBeGreaterThanOrEqual(0.7);
  });

  it('never suggests on news of a fix, a request or a how-to question', () => {
    for (const text of [
      'shipped the fix for the upload error 🚀',
      'the crash rate dropped to 0.1% after the hotfix',
      'would be great if the export did not crash on big files',
      'how do I stop the app from crashing on startup?',
      'can someone review my PR that fixes the broken login?',
    ]) {
      expect(scoreChatBugLikelihood(text), text).toMatchObject({ suggest: false });
    }
  });

  it('scores only the author prose: mentions, links and code fences carry no evidence', () => {
    const noise = '<@U0123ABC> see https://status.example.com/incidents/500-error and ```TypeError at line 3```';
    expect(scoreChatBugLikelihood(noise)).toMatchObject({ score: 0, features: [], suggest: false });
    expect(scoreChatBugLikelihood('<@U0123ABC> the upload is broken again')).toMatchObject({ suggest: true });
  });

  it('is deterministic and stamps its version and the fired features', () => {
    const text = 'every time I click save it crashes';
    const first = scoreChatBugLikelihood(text);
    expect(scoreChatBugLikelihood(text)).toEqual(first);
    expect(first.version).toBe(CHAT_BUG_CLASSIFIER_VERSION);
    expect(first.features).toEqual(expect.arrayContaining(['malfunction', 'repro-step', 'repetition']));
    expect(first.score).toBeGreaterThanOrEqual(CHAT_BUG_SUGGEST_THRESHOLD);
  });
});
