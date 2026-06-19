/**
 * Coverage for the New-plan kickoff brief resolution.
 *
 * Regression guard for the silent-drop bug (offsite-planner demo B3): the
 * curated brief `apps/operator/prompts/kickoffs/new-plan.md` was resolved via
 * the workspace DATA root (`papercuspPath()` → `~/.papercusp-workspaces/<id>/
 * .papercusp/…`), which never contains the repo's prompt files. So
 * `buildKickoffPromptFile({ kind: 'new-plan' })` always returned null and the
 * "New plan" launch dropped `--launch-context` — the planner pane opened with
 * `--role=planner` but NO interview brief. The fix resolves via `promptsDir()`
 * (the same resolver role personas use: dev cwd, the import.meta walk-up, AND
 * the packaged-desktop `PAPERCUSP_PROMPTS_DIR` env). These tests assert the
 * brief now resolves + carries its content, so the regression can't return.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildKickoffPromptFile } from '../prompt-file';

describe('buildKickoffPromptFile new-plan', () => {
  it('resolves the curated brief to a real temp file (not null)', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    // The pre-fix bug: papercuspPath() pointed at the workspace data root, the
    // file read threw, and this came back null → the launch dropped the brief.
    expect(path).not.toBeNull();
    expect(path).toMatch(/new-plan\.md$/);
  });

  it('writes the new-plan interview brief body into the file', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    // Stable markers from apps/operator/prompts/kickoffs/new-plan.md — the
    // interview-first contract + the plans:* authoring sequence the planner runs.
    expect(body).toMatch(/New plan — kickoff brief/);
    expect(body).toMatch(/Interview first, write second/);
    expect(body).toMatch(/plans:new/);
    expect(body).toMatch(/plans:lint/);
    // The {{harness_context}} placeholder must be substituted, never left raw.
    expect(body).not.toMatch(/\{\{harness_context\}\}/);
  });

  it('stamps the active harness into the brief when one is in context', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: 'papercup' });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    expect(body).toMatch(/\*\*Active harness:\*\* `papercup`/);
  });

  it('falls back to the "ask the user" harness line when none is in context', async () => {
    const path = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: null });
    expect(path).not.toBeNull();
    const body = readFileSync(path as string, 'utf8');
    expect(body).toMatch(/\*\*Active harness:\*\* none/);
  });
});
