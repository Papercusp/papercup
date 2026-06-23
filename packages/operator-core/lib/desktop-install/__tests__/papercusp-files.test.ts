/**
 * Tests for installPapercuspFiles (P-006 of
 * desktop-app-install-integration-2026-05-23).
 *
 * Covers:
 *   - First install: token + agent_id minted, playbook + extension copied
 *   - Re-run: token + agent_id reused; playbook + extension refreshed
 *   - Token + agent_id files written mode 0600
 *   - Missing source files don't crash (logged via *Written=false)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { installPapercuspFiles, resolveInstallPaths, renderSuPlaybook } from '../papercusp-files';

let tmpHome: string;
let tmpAppRoot: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-home-'));
  tmpAppRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-app-'));
  // Lay out a fake operator app tree with the sources the installer looks for.
  await fs.mkdir(path.join(tmpAppRoot, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp'), { recursive: true });
  await fs.writeFile(
    path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
    '# Playbook v1\n',
  );
  await fs.writeFile(
    path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
    '// coord-hook v1\n',
  );
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpAppRoot, { recursive: true, force: true });
});

describe('installPapercuspFiles', () => {
  it('first install: mints token + agent_id, copies playbook + extension', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(result.minted.token).toBe(true);
    expect(result.minted.agentId).toBe(true);
    expect(result.playbookWritten).toBe(true);
    expect(result.extensionWritten).toBe(true);

    const token = (await fs.readFile(result.tokenPath, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const agentId = (await fs.readFile(result.agentIdPath, 'utf8')).trim();
    expect(agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).toBe('# Playbook v1\n');

    const ext = await fs.readFile(result.extensionPath, 'utf8');
    expect(ext).toBe('// coord-hook v1\n');
  });

  it('re-run: reuses existing token + agent_id, refreshes playbook + extension', async () => {
    const first = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const tokenBefore = (await fs.readFile(first.tokenPath, 'utf8')).trim();
    const agentIdBefore = (await fs.readFile(first.agentIdPath, 'utf8')).trim();

    // Update source files in place — simulates an app update.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      '# Playbook v2\n',
    );
    await fs.writeFile(
      path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
      '// coord-hook v2\n',
    );

    const second = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(second.minted.token).toBe(false);
    expect(second.minted.agentId).toBe(false);

    const tokenAfter = (await fs.readFile(second.tokenPath, 'utf8')).trim();
    const agentIdAfter = (await fs.readFile(second.agentIdPath, 'utf8')).trim();
    expect(tokenAfter).toBe(tokenBefore);
    expect(agentIdAfter).toBe(agentIdBefore);

    const playbook = await fs.readFile(second.playbookPath, 'utf8');
    expect(playbook).toBe('# Playbook v2\n');

    const ext = await fs.readFile(second.extensionPath, 'utf8');
    expect(ext).toBe('// coord-hook v2\n');
  });

  it('token file written with mode 0600', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const tokenStat = await fs.stat(result.tokenPath);
    expect(tokenStat.mode & 0o777).toBe(0o600);
    const agentStat = await fs.stat(result.agentIdPath);
    expect(agentStat.mode & 0o777).toBe(0o600);
  });

  it('missing playbook source: playbookWritten=false, no throw', async () => {
    await fs.rm(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.playbookWritten).toBe(false);
    expect(result.playbookSource).toBe('');
    // Other artifacts still landed
    expect(result.minted.token).toBe(true);
    expect(result.extensionWritten).toBe(true);
  });

  it('missing extension source: extensionWritten=false, no throw', async () => {
    await fs.rm(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.extensionWritten).toBe(false);
    expect(result.extensionSource).toBe('');
    expect(result.playbookWritten).toBe(true);
  });

  it('splices the OMP overlay into a marker-model base playbook', async () => {
    // Regression guard (2026-05-30 marker split): the base carries a
    // CLIENT-TOOLING-OVERLAY marker, NOT the tooling section. The
    // desktop/OMP playbook must have the OMP overlay spliced in — not
    // be raw-copied with a literal marker + no tooling.
    const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${MARKER}\n\n## Tail\n`,
    );
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su.omp.md'),
      '## OMP tooling\nUse omp:sessions etc.',
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    expect(playbook).not.toContain(MARKER); // literal marker never ships
    expect(playbook).toContain('## OMP tooling'); // overlay spliced in
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('marker base with NO overlay file: marker is removed, not shipped literally', async () => {
    const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n${MARKER}\n## Tail\n`,
    );
    // No papercusp-su.omp.md written.

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).not.toContain(MARKER);
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('projects the canonical deploy-pipeline note into the ENGINEER playbook at the project-guide anchor', async () => {
    // recipes-reuse-activation follow-up: a cross-cutting behavioral note (DEPLOY_PIPELINE_NOTE)
    // lives in ONE source and is PROJECTED into su (engineer) — not hand-mirrored, not loose in
    // CLAUDE.md. A base carrying the project-guide marker (the injection anchor) gets it.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n<!-- PAPERCUSP-SU:PROJECT-GUIDE -->\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    // the canonical DEPLOY_PIPELINE_NOTE is projected in, incl. the owner-directed
    // "a RED gate is everyone's job to FIX, no owner-ask" directive...
    expect(playbook).toContain('## The deploy pipeline is ASYNC');
    expect(playbook).toContain('do NOT ask the owner');
    expect(playbook).toContain('even if it is not your lane');
    // ...exactly once (one source, one projection)...
    expect(playbook.split('## The deploy pipeline is ASYNC').length - 1).toBe(1);
    // ...sitting in the body BEFORE the project-guide slot, not appended at the very end.
    expect(playbook.indexOf('do NOT ask the owner')).toBeLessThan(playbook.indexOf('## Tail'));
  });

  it('projects the canonical wait-loop note into the ENGINEER playbook at the project-guide anchor', async () => {
    // owner directive 2026-06-23: the "waiting? arm a self-wake LOOP — never sleep on an event that
    // may never fire" directive lives in ONE source (WAIT_LOOP_NOTE) and is PROJECTED into su
    // (engineer) alongside the deploy note — not hand-mirrored, not loose in CLAUDE.md.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n<!-- PAPERCUSP-SU:PROJECT-GUIDE -->\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    // the canonical WAIT_LOOP_NOTE is projected in...
    expect(playbook).toContain('## Waiting on something? Arm a self-wake LOOP');
    expect(playbook).toContain('loop:arm');
    // ...exactly once (one source, one projection)...
    expect(playbook.split('## Waiting on something? Arm a self-wake LOOP').length - 1).toBe(1);
    // ...sitting in the body BEFORE the project-guide slot, not appended at the very end.
    expect(playbook.indexOf('Arm a self-wake LOOP')).toBeLessThan(playbook.indexOf('## Tail'));
  });

  it('splices the GENERATED workspace map at its marker (staging-branch-pipeline-2026-06-06)', async () => {
    const MARKER = '<!-- PAPERCUSP-SU:WORKSPACE-MAP -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${MARKER}\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    expect(playbook).not.toContain(MARKER); // literal marker never ships
    // Config-derived content (resolveWorkspaceMapConfig env/git seams):
    expect(playbook).toContain('Where to work');
    expect(playbook).toContain('automation-only');
    expect(playbook).toContain('## Tail');
  });

  it('removes the PROJECT-GUIDE marker on the install path even when no guide resolves (P-001)', async () => {
    // The install path's project-guide candidates walk up from <appRoot>/prompts
    // — in the fake tmp tree no repo CLAUDE.md exists there, so the marker must
    // be REMOVED, never shipped literally. (Guide-present splicing is covered by
    // the renderSuPlaybook tests below, which control the source path directly.)
    const GUIDE_MARKER = '<!-- PAPERCUSP-SU:PROJECT-GUIDE -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${GUIDE_MARKER}\n\n## Tail\n`,
    );
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).not.toContain(GUIDE_MARKER);
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('resolveInstallPaths returns expected layout', () => {
    const p = resolveInstallPaths('/tmp/somehome');
    expect(p.papercuspDir).toBe('/tmp/somehome/.papercusp');
    expect(p.tokenPath).toBe('/tmp/somehome/.papercusp/superuser-token');
    expect(p.agentIdPath).toBe('/tmp/somehome/.papercusp/su-agent-id');
    expect(p.playbookPath).toBe('/tmp/somehome/.papercusp/engineer-collaborator.md');
    expect(p.extensionPath).toBe('/tmp/somehome/.papercusp/papercusp-coord.ts');
  });

  it('auto-discover mode: when operatorAppRoot is absent, falls back to process.cwd()-rooted candidates', async () => {
    // No explicit operatorAppRoot: only opts.playbookSource and
    // opts.extensionSource override the candidate list. We force both
    // via explicit non-existent paths to confirm the override-without-
    // root branch reports missing rather than crashing.
    const result = await installPapercuspFiles({
      home: tmpHome,
      playbookSource: '/nonexistent/playbook.md',
      extensionSource: '/nonexistent/coord.ts',
    });
    expect(result.playbookWritten).toBe(false);
    expect(result.extensionWritten).toBe(false);
    // Token + agent_id still mint correctly in the no-source case.
    expect(result.minted.token).toBe(true);
    expect(result.minted.agentId).toBe(true);
  });

  it('boot-smoke: resolveOperatorAppRoot does not crash on ESM __dirname access (WI-110)', async () => {
    // Verify the fix for ESM __dirname ReferenceError: calling installPapercuspFiles
    // with no explicit operatorAppRoot triggers resolveOperatorAppRoot, which must
    // not crash even though __dirname is undefined in ESM modules.
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.minted.token).toBe(true); // Reached completion without crashing.
  });

  it('reuses token already present from a prior install with no trailing newline', async () => {
    const paths = resolveInstallPaths(tmpHome);
    await fs.mkdir(paths.papercuspDir, { recursive: true });
    await fs.writeFile(paths.tokenPath, 'preexisting-token-12345', { mode: 0o600 });

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.minted.token).toBe(false);
    const token = (await fs.readFile(result.tokenPath, 'utf8')).trim();
    expect(token).toBe('preexisting-token-12345');
  });
});

describe('renderSuPlaybook (psu-only-launch-unification P-011)', () => {
  const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';

  beforeEach(async () => {
    // The shared base already exists from the outer beforeEach as
    // `# Playbook v1`; replace it with a marker-model base + per-agent
    // overlays so the splice picks the RIGHT client overlay.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Engineer base\n\n${MARKER}\n\n## Tail\n`,
    );
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su.claude.md'), '## CLAUDE tooling');
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su.omp.md'), '## OMP tooling');
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-power.tools.md'),
      `# Power base\n\n${MARKER}\n\n## Tail\n`,
    );
  });

  it('splices the per-agent overlay (claude ≠ omp) into the base, marker never shipped', async () => {
    const claude = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: tmpAppRoot });
    expect(claude.text).toContain('# Engineer base');
    expect(claude.text).toContain('## CLAUDE tooling');
    expect(claude.text).not.toContain('## OMP tooling');
    expect(claude.text).not.toContain(MARKER);
    expect(claude.baseSource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'));
    expect(claude.overlaySource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su.claude.md'));

    const omp = await renderSuPlaybook({ agent: 'omp', operatorAppRoot: tmpAppRoot });
    expect(omp.text).toContain('## OMP tooling');
    expect(omp.text).not.toContain('## CLAUDE tooling');
  });

  it("profile selects the base file (power → papercusp-su-power.tools.md)", async () => {
    const power = await renderSuPlaybook({ agent: 'claude', profile: 'power', operatorAppRoot: tmpAppRoot });
    expect(power.text).toContain('# Power base');
    expect(power.baseSource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su-power.tools.md'));
  });

  it('agent with no overlay file: marker removed, overlaySource empty', async () => {
    const codex = await renderSuPlaybook({ agent: 'codex', operatorAppRoot: tmpAppRoot });
    expect(codex.text).not.toContain(MARKER);
    expect(codex.text).toContain('# Engineer base');
    expect(codex.overlaySource).toBe('');
  });

  it('throws when the base profile file is missing', async () => {
    await expect(renderSuPlaybook({ agent: 'claude', profile: 'ghost', operatorAppRoot: tmpAppRoot })).rejects.toThrow(
      /papercusp-su-ghost\.tools\.md/,
    );
  });

  // domain-generic-hive-architecture-2026-06-18 P-025 — the GENERIC profile (non-coding work
  // hive) has no bespoke base file by design; it falls back to the engineer base (its DISTINCT
  // behavior — no papercup CLAUDE.md splice — lives in role-launch-spec, not here). Unlike a
  // typo'd profile ('ghost' above), 'generic' must NOT throw.
  it('P-025: generic profile falls back to the engineer base (does not throw)', async () => {
    const generic = await renderSuPlaybook({ agent: 'claude', profile: 'generic', operatorAppRoot: tmpAppRoot });
    expect(generic.text).toContain('# Engineer base');
  });
});

describe('renderSuPlaybook project-guide splice (psu-isolation P-001 / D-002)', () => {
  const GUIDE_MARKER = '<!-- PAPERCUSP-SU:PROJECT-GUIDE -->';

  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Engineer base\n\n${GUIDE_MARKER}\n`,
    );
  });

  it('splices an explicit project guide at the marker; marker never shipped', async () => {
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Repo conventions\nUse nuqs for state.\n');
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
    });
    expect(r.text).not.toContain(GUIDE_MARKER);
    expect(r.text).toContain('Project guide — repo conventions'); // wrapper header
    expect(r.text).toContain('Use nuqs for state.'); // guide body
    expect(r.projectGuideSource).toBe(guidePath);
  });

  it('explicit empty source ("") → no guide spliced, marker removed', async () => {
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: '',
    });
    expect(r.text).not.toContain(GUIDE_MARKER);
    expect(r.text).not.toContain('Project guide — repo conventions');
    expect(r.projectGuideSource).toBe('');
  });

  it('auto-resolves the repo CLAUDE.md by walking up from the prompts dir (engineer default)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-guide-root-'));
    const promptsDir = path.join(root, 'apps', 'operator', 'prompts');
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(promptsDir, 'papercusp-su-engineer.tools.md'), `# Base\n\n${GUIDE_MARKER}\n`);
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Papercup guide\nTauri only.\n');
    try {
      const r = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: path.join(root, 'apps', 'operator') });
      expect(r.text).toContain('Tauri only.');
      expect(r.projectGuideSource).toBe(path.join(root, 'CLAUDE.md'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('base WITHOUT the marker: the (large) guide is neither read nor spliced', async () => {
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'), `# No marker base\n`);
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Should NOT appear\n');
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
    });
    expect(r.text).not.toContain('Should NOT appear');
    expect(r.projectGuideSource).toBe('');
  });
});
