import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
// operator.tools.md is DELIBERATELY absent. It drives the `operator-converse`
// chat surface, whose tool surface does NOT include `consult:get_feedback`, and
// `tools-md-sync.test.ts` fails any *.tools.md that NAMES a tool absent from its
// own role surface. Requiring the literal here made the two guards contradict
// each other outright: satisfying one necessarily reddened the other, which is
// what commit 565eec8d8e hit when it de-named the tool to green tools-md-sync
// and thereby blanked guidanceBlock()'s marker. R-3/R-4 scope the block to
// prompts that drive a WORKING agent, which operator-converse is not.
// FOLLOW-UP (WI-10002729): worker.tools.md DOES drive a working agent and DOES
// carry the tool, but is not listed below — it states the same rules in
// different words than the literal predicates here, so adding it needs a prompt
// rewording, not a list edit. That is a real coverage gap, not a decision to
// leave it unguarded.
// The negative controls below read THIS file BY NAME, never by list position:
// each mutates a real block and asserts the predicate then fails, so if the list
// order shifts under them they would mutate a file that never carried the phrase,
// the .replace() would be a no-op, and the control would pass VACUOUSLY.
const NEGATIVE_CONTROL_FILE = 'apps/operator/prompts/papercup.tools.md';
const GUIDANCE_FILES = [
  'apps/operator/prompts/papercup.tools.md',
  'apps/operator/prompts/papercup-deep.tools.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/agent-base-preamble.md',
];

function guidanceBlock(text: string): string {
  const marker = text.toLowerCase().indexOf('consult:get_feedback');
  if (marker < 0) return '';
  const nextHeading = text.slice(marker).search(/\n#{1,6} /);
  return text.slice(marker, nextHeading < 0 ? undefined : marker + nextHeading)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join(' ');
}

function hasWhenGuidance(block: string): boolean {
  const lower = block.toLowerCase().split(/\r?\n/).map((line) => line.trim()).join(' ');
  return lower.includes('first-pass check of local code, docs, or search') &&
    (lower.includes('use it once') || lower.includes('use it for one')) &&
    lower.includes('what you tried');
}

function hasWhenNotGuidance(block: string): boolean {
  const lower = block.toLowerCase().split(/\r?\n/).map((line) => line.trim()).join(' ');
  return lower.includes('live state') && lower.includes('known agent') &&
    lower.includes('owner decisions') && lower.includes('no_available_responder') &&
    (lower.includes('code/docs/search already answer') || lower.includes('code, docs, or search already answer'));
}

function hasDispatchGuidance(block: string): boolean {
  const lower = block.toLowerCase();
  return lower.includes('archive') && lower.includes('isolated answer session') &&
    lower.includes('does not wake the expert') && lower.includes('walled');
}

describe('consult:get_feedback prompt guidance (P-008)', () => {
  for (const relativePath of GUIDANCE_FILES) {
    it(`${relativePath} carries the bounded when/when-not block`, () => {
      const block = guidanceBlock(readFileSync(join(REPO, relativePath), 'utf8'));
      expect(block).toContain('consult:get_feedback');
      expect(hasWhenGuidance(block)).toBe(true);
      expect(hasWhenNotGuidance(block)).toBe(true);
      expect(hasDispatchGuidance(block)).toBe(true);
    });
  }
});

describe('consult:get_feedback prompt guard negative controls (P-008)', () => {
  it('positive guard accepts a prompt block that contains both calibrated-use rules', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const block = guidanceBlock(source);
    expect(hasWhenGuidance(block)).toBe(true);
    expect(hasWhenNotGuidance(block)).toBe(true);
  });

  it('negative control: removing the when condition is detected', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const broken = guidanceBlock(source).replace('first-pass check of local code, docs, or search', 'first-pass check');
    expect(hasWhenGuidance(broken)).toBe(false);
  });

  it('negative control: removing a when-not exclusion is detected', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const broken = guidanceBlock(source).replace('live state', 'fresh status');
    expect(hasWhenNotGuidance(broken)).toBe(false);
  });
});
