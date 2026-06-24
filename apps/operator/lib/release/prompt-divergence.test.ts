/**
 * Prompt divergence guard tests — decouple-agent-prompts-from-release-gate P-004.
 * Builds controlled temp trees (a live prompt root + a source tree) and asserts
 * the guard reports content drift, missing files, and the no-divergence cases.
 * Pure FS, no network/git.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  comparePromptRoots,
  detectHarnessPromptDivergence,
  detectSidecarPromptDrift,
  BASE_HARNESS_PROMPT_FILES,
} from './prompt-divergence';

function writeFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

const QUEEN = 'blueprints/base/prompts/queen.md';
const BEE = 'blueprints/base/prompts/bee.md';

describe('comparePromptRoots', () => {
  it('identical roots ⇒ ok with no comparison (no-override case)', () => {
    const d = mkdtempSync(join(tmpdir(), 'pd-same-'));
    try {
      const r = comparePromptRoots(d, d);
      expect(r.ok).toBe(true);
      expect(r.checked).toBe(0);
      expect(r.note).toMatch(/no decoupling/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('matching content across two roots ⇒ ok', () => {
    const live = mkdtempSync(join(tmpdir(), 'pd-live-'));
    const src = mkdtempSync(join(tmpdir(), 'pd-src-'));
    try {
      writeFile(live, QUEEN, '# QUEEN');
      writeFile(src, QUEEN, '# QUEEN');
      const r = comparePromptRoots(live, src, [QUEEN]);
      expect(r.ok).toBe(true);
      expect(r.checked).toBe(1);
      expect(r.divergences).toEqual([]);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('differing content ⇒ content-differs divergence (the "edit not live" case)', () => {
    const live = mkdtempSync(join(tmpdir(), 'pd-live-'));
    const src = mkdtempSync(join(tmpdir(), 'pd-src-'));
    try {
      writeFile(live, QUEEN, '# OLD QUEEN (live, stale)');
      writeFile(src, QUEEN, '# NEW QUEEN (working tree edit)');
      const r = comparePromptRoots(live, src, [QUEEN]);
      expect(r.ok).toBe(false);
      expect(r.divergences).toHaveLength(1);
      expect(r.divergences[0]).toMatchObject({ file: QUEEN, reason: 'content-differs' });
      expect(r.divergences[0].liveHash).not.toBe(r.divergences[0].sourceHash);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('present in source but missing in live ⇒ missing-in-live (a new prompt not yet live)', () => {
    const live = mkdtempSync(join(tmpdir(), 'pd-live-'));
    const src = mkdtempSync(join(tmpdir(), 'pd-src-'));
    try {
      writeFile(src, BEE, '# NEW BEE');
      const r = comparePromptRoots(live, src, [BEE]);
      expect(r.ok).toBe(false);
      expect(r.divergences[0]).toMatchObject({ file: BEE, reason: 'missing-in-live', liveHash: null });
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('a file absent in BOTH trees is not counted', () => {
    const live = mkdtempSync(join(tmpdir(), 'pd-live-'));
    const src = mkdtempSync(join(tmpdir(), 'pd-src-'));
    try {
      const r = comparePromptRoots(live, src, [QUEEN, BEE]);
      expect(r.ok).toBe(true);
      expect(r.checked).toBe(0);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });
});

describe('detectHarnessPromptDivergence', () => {
  it('derives <sourceRoot>/libs/papercusp/packages/harness and compares vs an explicit liveRoot', () => {
    const live = mkdtempSync(join(tmpdir(), 'pd-live-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'pd-srcroot-'));
    try {
      writeFile(live, QUEEN, '# LIVE');
      writeFile(join(sourceRoot, 'libs', 'papercusp', 'packages', 'harness'), QUEEN, '# SOURCE EDIT');
      const r = detectHarnessPromptDivergence({ sourceRoot, liveRoot: live, files: [QUEEN] });
      expect(r.ok).toBe(false);
      expect(r.divergences[0]).toMatchObject({ file: QUEEN, reason: 'content-differs' });
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('detectSidecarPromptDrift', () => {
  it('no sidecar bundle present ⇒ ok, no-op note', () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), 'pd-sidecar-empty-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'pd-srcroot-'));
    try {
      const r = detectSidecarPromptDrift({ sidecarRoot, sourceRoot, files: [QUEEN] });
      expect(r.ok).toBe(true);
      expect(r.note).toMatch(/no sidecar harness bundle/);
    } finally {
      rmSync(sidecarRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it('sidecar bundle (sidecar/harness) drifted from source ⇒ divergence', () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), 'pd-sidecar-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'pd-srcroot-'));
    try {
      // Sidecar layout: <sidecarRoot>/harness/blueprints/...
      writeFile(join(sidecarRoot, 'harness'), QUEEN, '# BUNDLED (stale)');
      writeFile(join(sourceRoot, 'libs', 'papercusp', 'packages', 'harness'), QUEEN, '# SOURCE (edited)');
      const r = detectSidecarPromptDrift({ sidecarRoot, sourceRoot, files: [QUEEN] });
      expect(r.ok).toBe(false);
      expect(r.divergences[0]).toMatchObject({ file: QUEEN, reason: 'content-differs' });
    } finally {
      rmSync(sidecarRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('BASE_HARNESS_PROMPT_FILES', () => {
  it('lists base-blueprint prompt paths under blueprints/', () => {
    expect(BASE_HARNESS_PROMPT_FILES.length).toBeGreaterThan(0);
    for (const f of BASE_HARNESS_PROMPT_FILES) expect(f).toMatch(/^blueprints\/.+\/prompts\/.+\.md$/);
  });
});
