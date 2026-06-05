/**
 * Phase 4 T2.3 scratch-URI unit tests.
 *
 * Path-traversal validation is security-sensitive — these tests
 * pin every rejection case the reviewer flagged in concern #5.
 */
import { describe, expect, it } from 'vitest';
import {
  parseScratchUri,
  validateBasename,
  buildScratchUri,
  safeScratchFilesystemPath,
  scratchRootForWorkspace,
  ScratchUriError,
} from './scratch-uri';

const VALID_RUN = '12345678-1234-4567-8abc-1234567890ab';
const VALID_WS = 'workspace-A';
const VALID_TOOL = 'bigquery:export';
const VALID_BASE = 'result.csv';

describe('scratch URI — parsing', () => {
  it('parses a well-formed URI', () => {
    const uri = `papercusp://scratch/${VALID_WS}/${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
    const parts = parseScratchUri(uri);
    expect(parts).toEqual({
      workspaceId: VALID_WS,
      toolName: VALID_TOOL,
      runId: VALID_RUN,
      basename: VALID_BASE,
    });
  });

  it('rejects wrong scheme', () => {
    expect(() => parseScratchUri('https://scratch/ws/tool/run/file')).toThrow(ScratchUriError);
    expect(() => parseScratchUri('file:///etc/passwd')).toThrow(ScratchUriError);
  });

  it('rejects wrong segment count', () => {
    expect(() => parseScratchUri('papercusp://scratch/ws/tool/run')).toThrow(/4 segments/);
    expect(() =>
      parseScratchUri('papercusp://scratch/ws/tool/run/sub/file'),
    ).toThrow(/4 segments/);
  });

  it('rejects forbidden chars (CR/LF/null/percent)', () => {
    for (const bad of ['\r', '\n', '\0', '%']) {
      const uri = `papercusp://scratch/${VALID_WS}${bad}/${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
      expect(() => parseScratchUri(uri)).toThrow(/forbidden/);
    }
  });

  it('rejects runId that is not a UUID', () => {
    const uri = `papercusp://scratch/${VALID_WS}/${VALID_TOOL}/not-a-uuid/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow(/runId/);
  });

  it('rejects toolName missing namespace separator', () => {
    const uri = `papercusp://scratch/${VALID_WS}/justaname/${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow(/namespace separator/);
  });

  it('rejects toolName with bad chars', () => {
    const uri = `papercusp://scratch/${VALID_WS}/tool/with space:bad/${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow();
  });

  it('rejects bad workspace shape', () => {
    const uri = `papercusp://scratch/has space/${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow();
  });

  // Regression for round-11 audit bug #26: workspaceId="." or ".." passed
  // WORKSPACE_REGEX (which allows dots) and let join+resolve escape the
  // scratch base. parseScratchUri now rejects them, AND safeScratchFilesystemPath
  // verifies global-root containment as defense-in-depth.
  it('rejects "." as workspace (path-traversal regression)', () => {
    const uri = `papercusp://scratch/./${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow(/invalid shape/);
  });
  it('rejects ".." as workspace (path-traversal regression)', () => {
    const uri = `papercusp://scratch/../${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow(/invalid shape/);
  });
  it('rejects "." as toolName', () => {
    const uri = `papercusp://scratch/${VALID_WS}/./${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow();
  });
  it('rejects ".." as toolName', () => {
    const uri = `papercusp://scratch/${VALID_WS}/../${VALID_RUN}/${VALID_BASE}`;
    expect(() => parseScratchUri(uri)).toThrow();
  });
});

describe('scratch basename validation', () => {
  it('accepts safe filenames', () => {
    for (const ok of ['result.csv', 'file_1.json', 'a-b-c.txt.gz', 'X', '1.tar.gz']) {
      expect(() => validateBasename(ok)).not.toThrow();
    }
  });

  it('rejects empty', () => {
    expect(() => validateBasename('')).toThrow(/must not be empty/);
  });

  it('rejects . and ..', () => {
    expect(() => validateBasename('.')).toThrow(/cannot be/);
    expect(() => validateBasename('..')).toThrow(/cannot be/);
  });

  it('rejects leading/trailing dot', () => {
    expect(() => validateBasename('.hidden')).toThrow(/start or end with/);
    expect(() => validateBasename('trailing.')).toThrow(/start or end with/);
  });

  it('rejects path separators in basename', () => {
    expect(() => validateBasename('sub/file')).toThrow(/forbidden characters/);
    expect(() => validateBasename('sub\\file')).toThrow(/forbidden characters/);
    expect(() => validateBasename('a/b/c')).toThrow();
  });

  it('rejects absolute-path-style', () => {
    expect(() => validateBasename('/etc/passwd')).toThrow();
    expect(() => validateBasename('C:/Windows/file.txt')).toThrow();
  });

  it('rejects ~ and shell metacharacters', () => {
    expect(() => validateBasename('~/secret')).toThrow();
    expect(() => validateBasename('file$NAME')).toThrow();
    expect(() => validateBasename('back`tick')).toThrow();
  });

  it('rejects names over 255 chars', () => {
    expect(() => validateBasename('a'.repeat(256))).toThrow(/255/);
  });

  it('rejects unicode (the regex is intentionally ASCII)', () => {
    expect(() => validateBasename('résumé.txt')).toThrow();
  });
});

describe('scratch URI — buildScratchUri', () => {
  it('round-trips valid parts', () => {
    const uri = buildScratchUri({
      workspaceId: VALID_WS,
      toolName: VALID_TOOL,
      runId: VALID_RUN,
      basename: VALID_BASE,
    });
    expect(parseScratchUri(uri)).toEqual({
      workspaceId: VALID_WS,
      toolName: VALID_TOOL,
      runId: VALID_RUN,
      basename: VALID_BASE,
    });
  });

  it('refuses to build a URI from invalid parts', () => {
    expect(() => buildScratchUri({
      workspaceId: VALID_WS,
      toolName: 'no-separator-here',
      runId: VALID_RUN,
      basename: VALID_BASE,
    })).toThrow();
    expect(() => buildScratchUri({
      workspaceId: VALID_WS,
      toolName: VALID_TOOL,
      runId: VALID_RUN,
      basename: '..',
    })).toThrow();
  });
});

describe('safeScratchFilesystemPath', () => {
  it('resolves a valid URI to a containment-checked absolute path', () => {
    const uri = `papercusp://scratch/${VALID_WS}/${VALID_TOOL}/${VALID_RUN}/${VALID_BASE}`;
    const p = safeScratchFilesystemPath(uri);
    const root = scratchRootForWorkspace(VALID_WS);
    expect(p.startsWith(root + '/') || p === root).toBe(true);
    expect(p).toContain(VALID_BASE);
  });

  it('throws on any invalid URI (delegates to parser)', () => {
    expect(() => safeScratchFilesystemPath('papercusp://scratch/ws/tool/run')).toThrow();
    expect(() => safeScratchFilesystemPath('papercusp://scratch/ws/tool/run/..')).toThrow();
  });
});
