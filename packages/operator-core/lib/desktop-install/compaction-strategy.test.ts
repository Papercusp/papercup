/**
 * renderCompactionStrategy — the Claude compaction floor render
 * (agent-managed-compaction-2026-07-01 P-005). Pure splice over temp fixtures:
 * base + claude overlay -> body, marker + leading comments stripped, banner stamped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderCompactionStrategy } from './papercusp-files';

describe('renderCompactionStrategy (Claude compaction floor)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-'));
    await fs.writeFile(
      path.join(dir, 'papercusp-compaction.base.md'),
      '<!-- canonical comment -->\n# Compaction\nPRESERVE_BASE_XYZ\n\n<!-- PAPERCUSP-COMPACTION:CLIENT-OVERLAY -->\n',
    );
    await fs.writeFile(
      path.join(dir, 'papercusp-compaction.claude.md'),
      '<!-- overlay comment -->\n## Claude one-shot\nCLAUDE_OVERLAY_XYZ\n',
    );
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('splices the claude overlay at the marker; strips comments + marker; stamps banner', async () => {
    const out = await renderCompactionStrategy(dir);
    expect(out).toContain('PRESERVE_BASE_XYZ'); // base body kept
    expect(out).toContain('CLAUDE_OVERLAY_XYZ'); // overlay spliced in
    expect(out).not.toContain('PAPERCUSP-COMPACTION:CLIENT-OVERLAY'); // marker removed
    expect(out).not.toContain('canonical comment'); // base leading comment stripped
    expect(out).not.toContain('overlay comment'); // overlay leading comment stripped
    expect(out).toContain('do not hand-edit'); // generated banner present
  });

  it('returns empty string when the base file is missing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-empty-'));
    expect(await renderCompactionStrategy(empty)).toBe('');
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('keeps the canonical directive-verification wording tied to search-hit origin', async () => {
    const source = await fs.readFile(
      new URL('../../../../apps/operator/prompts/papercusp-compaction.base.md', import.meta.url),
      'utf8',
    );

    expect(source).toContain('`provenance.turn_origin`');
    expect(source).toContain("origin:'loop-fire'");
    expect(source).toContain("even when `speaker:'user'`");
    expect(source).toContain('Missing, unrecognized, or `unknown` origin is UNKNOWN');
    expect(source).toContain('never infer');
  });

  it('keeps owner-facing obligations outside the active task as a distinct carry class', async () => {
    const source = await fs.readFile(
      new URL('../../../../apps/operator/prompts/papercusp-compaction.base.md', import.meta.url),
      'utf8',
    );

    expect(source).toContain('**Owner-facing open threads**');
    expect(source).toContain('even when it is unrelated to the active task');
    expect(source).toContain('answered,\n  withdrawn, or superseded');
    expect(source).toContain('label these under `left`');
    expect(source).toContain('use `walls` only when the next action belongs to');
  });
});
