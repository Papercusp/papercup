/**
 * codex-overlay-launch-context.test.ts — proves the CANONICAL Codex overlay edit
 * actually reaches a live launch context (P-010,
 * fleet-friction-remediation-2026-08-21).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM su-render-baseline.test.ts: that suite is
 * deliberately pinned to FROZEN FIXTURES under `__fixtures__/su-render-baseline/`
 * and renders only the `claude` overlay — by design, so its byte/hash table stays
 * comparable across persona edits. The consequence is that it cannot notice a
 * change to the LIVE `apps/operator/prompts/papercusp-su.codex.md`, and nothing
 * else did either. The su persona runbook's central warning is that the prompt is
 * LAYERED AND PROJECTED, so an edit can land on a real file and still never reach
 * a launched session — the "I changed the prompt and nothing happened" trap. This
 * renders the REAL prompt tree and asserts the guidance is in the shipped text.
 *
 * THE CLAUDE CONTROL IS THE LOAD-BEARING HALF. Asserting only that the rendered
 * codex text contains the guidance would also pass if the string had been written
 * into the shared BASE playbook (which every client receives) rather than the
 * codex overlay — i.e. it would pass while the delivery mechanism under test was
 * broken. Rendering `claude` from the same live tree and asserting the guidance is
 * ABSENT pins it to the overlay specifically.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from './papercusp-files';

// __dirname = <repo>/packages/operator-core/lib/desktop-install — four levels down.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const OPERATOR_APP_ROOT = join(REPO_ROOT, 'apps', 'operator');

const render = (agent: string) => renderSuPlaybook({ agent, operatorAppRoot: OPERATOR_APP_ROOT });

/** Load-bearing phrases from the two P-010 sections of the codex overlay. Each is a
 *  claim an agent acts on, not decoration — so each is asserted individually and a
 *  failure names exactly which guarantee stopped shipping. */
const CODEX_GUIDANCE = [
  // apply_patch atomic-update constraint
  'at most one operation per target path',
  'multiple operations target',
  'one block per FILE, one `@@` hunk per REGION',
  // shell/heredoc quoting
  "quote the opening delimiter",
  'closing delimiter must be at column 0',
  // nested exec session-handle preservation
  'preserve the **whole returned envelope**',
  'every returned `session_id`',
  'Never map a nested response to `output` alone',
] as const;

describe('codex overlay reaches live launch context (P-010)', () => {
  it('resolves the REAL codex overlay file, not a fixture', async () => {
    const rendered = await render('codex');
    // If this is '', readAgentOverlay silently found no file and every content
    // assertion below would be vacuous.
    expect(rendered.overlaySource).not.toBe('');
    expect(rendered.overlaySource).toContain('papercusp-su.codex.md');
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it.each(CODEX_GUIDANCE)('a launched Codex session receives: %s', async (phrase) => {
    const { text } = await render('codex');
    expect(text).toContain(phrase);
  });

  it('drains a nested exec session through every yielded poll', async () => {
    const { text } = await render('codex');
    expect(text).toContain('while ("session_id" in result && !("exit_code" in result))');
    expect(text).toContain('result = await tools.write_stdin');
    expect(text).toContain('continue until an');
    expect(text).toContain('`exit_code` is present');
  });

  it('CONTROL: the same phrases are absent from the claude render (overlay-scoped, not base)', async () => {
    const { text, overlaySource } = await render('claude');
    // A `not.toContain` sweep passes trivially against an empty or failed render,
    // which would make this control inert exactly when it matters. Prove the claude
    // render is real and substantial FIRST, so the absence below is a finding.
    expect(overlaySource).toContain('papercusp-su.claude.md');
    expect(text.length).toBeGreaterThan(10_000);
    for (const phrase of CODEX_GUIDANCE) {
      expect(text).not.toContain(phrase);
    }
  });

  it('keeps the pre-existing functions.exec JavaScript-boundary guidance', async () => {
    // P-010 extends the codex overlay; it must not displace what was already
    // delivered there (the trap family this overlay originally existed for).
    const { text } = await render('codex');
    expect(text).toContain('the outer\nprogram is JavaScript');
    expect(text).toContain('yield_time_ms');
  });
});
