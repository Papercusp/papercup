import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const GUIDANCE_FILES = [
  'apps/operator/prompts/operator.tools.md',
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
    const source = readFileSync(join(REPO, GUIDANCE_FILES[1]), 'utf8');
    const block = guidanceBlock(source);
    expect(hasWhenGuidance(block)).toBe(true);
    expect(hasWhenNotGuidance(block)).toBe(true);
  });

  it('negative control: removing the when condition is detected', () => {
    const source = readFileSync(join(REPO, GUIDANCE_FILES[1]), 'utf8');
    const broken = guidanceBlock(source).replace('first-pass check of local code, docs, or search', 'first-pass check');
    expect(hasWhenGuidance(broken)).toBe(false);
  });

  it('negative control: removing a when-not exclusion is detected', () => {
    const source = readFileSync(join(REPO, GUIDANCE_FILES[1]), 'utf8');
    const broken = guidanceBlock(source).replace('live state', 'fresh status');
    expect(hasWhenNotGuidance(broken)).toBe(false);
  });
});
