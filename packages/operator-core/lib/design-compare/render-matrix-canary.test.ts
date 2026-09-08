import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateRenderMatrix } from './render-matrix';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const directory = resolve(root, 'docs/evidence/desktop-render-matrix-p003-2026-09-08');
const matrix = JSON.parse(readFileSync(resolve(directory, 'reviewed-matrix.json'), 'utf8'));
const journey = JSON.parse(readFileSync(resolve(root, 'docs/evidence/desktop-design-journey-p002-2026-09-08.json'), 'utf8'));
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('saved desktop canary render evidence', () => {
  it('has a reviewed, hash-verified capture for each state/viewport/theme', () => {
    expect(evaluateRenderMatrix(matrix.contract, matrix.observations).satisfied).toBe(true);
    expect(matrix.contract.cases).toHaveLength(20);
    expect(digest(resolve(root, matrix.referencePath))).toBe(matrix.contract.reference.contentSha256);
    for (const observation of matrix.observations) {
      expect(digest(resolve(root, observation.capture.path))).toBe(observation.capture.sha256);
      expect(observation.evidenceKind).toBe('fixture');
      expect(observation.connectivity).toBe('not-exercised');
    }
  });
  it('keeps the original wrong-entry failure distinct from the repaired real disconnected evidence', () => {
    expect(journey.original.testRunId).toBe(matrix.realServiceEvidence.originalTestRunId);
    expect(journey.positive.testRunId).toBe(matrix.realServiceEvidence.repairedTestRunId);
    expect(journey.original.cases).toHaveLength(6);
    for (const original of journey.original.cases) {
      expect(original.shellReady).toBe(true);
      expect(original.desktopWorkspacePresent).toBe(false);
      expect(original.cloudManagementPresent).toBe(true);
    }
    expect(journey.positive.status).toBe('pass');
    expect(matrix.realServiceEvidence.observedState).toBe('disconnected');
    // Original entry never reached the required component: it has no state
    // observations and cannot borrow the repaired fixture's matrix proof.
    expect(evaluateRenderMatrix(matrix.contract, []).satisfied).toBe(false);
  });
  it('keeps every side-by-side gallery image resolvable and byte-bound', () => {
    const html = readFileSync(resolve(directory, 'review.html'), 'utf8');
    const images = [...html.matchAll(/<img src="([^"]+)"/g)].map(match => match[1]!);
    expect(images).toHaveLength(43);
    for (const image of images) expect(existsSync(resolve(directory, image))).toBe(true);
    for (const capture of journey.captures) expect(digest(resolve(root, capture.path))).toBe(capture.sha256);
  });
});
