import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { buildFrameBootstrap, FRAME_BOOTSTRAP_STEPS } from './frame-bootstrap';

const baseEnv = { setup: [], install: [], build: [], test: [], run: [], services: [], ports: [], env: {} };

/**
 * Parse the script with `bash -n` (syntax only — nothing executes).
 *
 * This exists because every other assertion in this file is a `toContain`, and a substring
 * check cannot see a SYNTAX error: the script can contain every expected fragment and still
 * be unparseable, in which case the frame's whole bootstrap dies on a remote VM at deploy
 * time with none of these tests having gone red. That is not hypothetical — building the GL
 * section (P-002) emitted a `case` pattern containing an unquoted space
 * (`*software rasterizer*`), which bash rejects outright, taking the entire section with it.
 * Any generator that interpolates values into shell can reintroduce that class, so the guard
 * is on the emitted script itself rather than on any one fragment of it.
 */
function assertParses(script: string, label: string): void {
  try {
    execFileSync('bash', ['-n'], {
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    const err = e as { stderr?: Buffer };
    throw new Error(`emitted bootstrap (${label}) is not valid bash:\n${err.stderr?.toString() ?? String(e)}`);
  }
}

describe('buildFrameBootstrap', () => {
  it('emits a valid bash header + every step for a full coding frame', () => {
    const { script, steps } = buildFrameBootstrap({
      harnessSlug: 'papercup',
      repoUrl: 'https://github.com/acme/repo.git',
      environment: {
        ...baseEnv,
        setup: ['nvm install 22'],
        install: ['npm ci'],
        build: ['npm run build'],
        services: [{ name: 'redis', command: 'redis-server', port: 6379 }],
        env: { NODE_ENV: 'production' },
      },
      claudeCredentialsRemotePath: '/root/creds.json',
      desktop: true,
    });
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('Frame for harness: papercup');
    // every section present
    for (const s of FRAME_BOOTSTRAP_STEPS) expect(steps).toContain(s);
    expect(script).toContain('nvm install 22');
    expect(script).toContain('npm ci');
    expect(script).toContain('redis-server');
    expect(script).toContain("export NODE_ENV='production'");
    expect(script).toContain('PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='); // scoped to one harness
  });

  it('repo-less harness omits the repo step', () => {
    const { steps } = buildFrameBootstrap({ harnessSlug: 'research', environment: baseEnv });
    expect(steps).not.toContain('repo');
  });

  it('no credentials → no credentials step', () => {
    const { steps } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    expect(steps).not.toContain('credentials');
  });

  it('token channel: mounts the staged OAuth token and exports CLAUDE_CODE_OAUTH_TOKEN', () => {
    const { script, steps } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      claudeTokenRemotePath: '/root/papercusp-claude-token',
    });
    expect(steps).toContain('credentials');
    expect(script).toContain("install -m 0600 '/root/papercusp-claude-token' \"$HOME/.papercusp/claude-token\"");
    expect(script).toContain('export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.papercusp/claude-token")"');
    // token-only → no credentials-bundle install
    expect(script).not.toContain('.credentials.json');
  });

  it('runtime tarball delivery: untars instead of the anonymous clone (private repo)', () => {
    const { script, steps } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      runtimeTarballRemotePath: '/root/papercusp-runtime.tgz',
    });
    expect(steps).toContain('runtime');
    expect(script).toContain("tar xzf '/root/papercusp-runtime.tgz' -C '/opt/papercusp/runtime'");
    expect(script).not.toContain('git clone --depth 1 https://github.com/Papercusp/papercup.git');
  });

  it('explicit runtimeSetup still wins over the tarball default', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      runtimeTarballRemotePath: '/root/papercusp-runtime.tgz',
      runtimeSetup: ['fetch-prebuilt-bundle.sh'],
    });
    expect(script).toContain('fetch-prebuilt-bundle.sh');
    expect(script).not.toContain('tar xzf');
  });

  it('both channels can coexist in one credentials step', () => {
    const { script, steps } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      claudeCredentialsRemotePath: '/root/creds.json',
      claudeTokenRemotePath: '/root/tok',
    });
    expect(steps.filter((s) => s === 'credentials')).toHaveLength(1);
    expect(script).toContain('.credentials.json');
    expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('embedded-pg step sources ALL role passwords per-frame, not the baked dev literals (audit P-031)', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    // No repo-public role password on a provisioned frame:
    expect(script).not.toContain("PASSWORD 'harness_admin_pwd'");
    expect(script).not.toContain("PASSWORD 'harness_app_pwd'");
    expect(script).not.toContain("PASSWORD 'harness_zero_pwd'");
    expect(script).not.toContain('harness_admin:harness_admin_pwd@');
    expect(script).not.toContain('harness_app:harness_app_pwd@');
    // Env override → random per-frame fallback, ALTER re-keys on re-bootstrap:
    expect(script).toContain('PAPERCUSP_FRAME_PG_PASSWORD');
    expect(script).toContain('PAPERCUSP_FRAME_PG_APP_PASSWORD');
    expect(script).toContain('PAPERCUSP_FRAME_PG_ZERO_PASSWORD');
    expect(script).toContain('openssl rand -hex 24');
    expect(script).toContain('ALTER ROLE harness_admin WITH LOGIN SUPERUSER PASSWORD');
    expect(script).toContain('ALTER ROLE harness_app WITH LOGIN PASSWORD');
    expect(script).toContain('ALTER ROLE harness_zero WITH LOGIN PASSWORD');
    // DSNs carry the variables; the app DSN is exported for getOrgPgApp's
    // env-first resolution (its fallback literal no longer matches):
    expect(script).toContain('postgresql://harness_admin:$HARNESS_ADMIN_PWD@localhost:5432/papercusp');
    expect(script).toContain('export HARNESS_DATABASE_URL="postgresql://harness_app:$HARNESS_APP_PWD@localhost:5432/papercusp"');
    // Both DSNs persist 0600 for relaunches:
    expect(script).toContain('frame-pg.env');
    expect(script).toContain('install -m 0600');
    expect(script).toContain('DATABASE_URL=%s\\nHARNESS_DATABASE_URL=%s\\n');
  });

  it('embeddedPg:false and orchestratorOnFrame:false drop those sections', () => {
    const { steps, script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      embeddedPg: false,
      orchestratorOnFrame: false,
    });
    expect(steps).not.toContain('embedded-pg');
    expect(steps).not.toContain('orchestrator-loop');
    expect(script).not.toContain('PAPERCUSP_DBOS_ORCHESTRATOR=1');
  });

  it('custom runtimeSetup replaces the default clone+build', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      runtimeSetup: ['curl -fsSL https://bundles.example/runtime.tgz | tar xz -C /opt/papercusp/runtime'],
    });
    expect(script).toContain('bundles.example/runtime.tgz');
    expect(script).not.toContain('git clone --depth 1 https://github.com/Papercusp/papercup.git');
  });

  it('shell-quotes interpolated values (no injection from a slug)', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: "x'; rm -rf /", environment: baseEnv });
    expect(script).toContain(`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='x'\\''; rm -rf /'`);
  });

  it('non-omp backend does not install OMP', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv, agentBackend: 'claude' });
    expect(script).not.toContain('@oh-my-pi/pi-coding-agent');
    expect(script).toContain('backend is not omp — OMP CLI not installed');
    expect(script).toContain("AGENT_BACKEND='claude-code'");
  });

  it('OMP backend installs the CLI but leaves gateway/account routing to the runtime', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv, agentBackend: 'omp' });
    expect(script).toContain('@oh-my-pi/pi-coding-agent');
    expect(script).toContain('OMP gateway/account routing is supplied per spawn by the runtime');
    expect(script).not.toContain('@rynfar/meridian');
    expect(script).not.toContain('meridian >/var/log/meridian.log');
  });

  it('exports the instance config via HARNESS_CONFIG_JSON when provided (P-008)', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      instanceConfigJson: '{"phase":"production","maxCostUsd":5}',
    });
    expect(script).toContain(`export HARNESS_CONFIG_JSON='{"phase":"production","maxCostUsd":5}'`);
  });

  it('omits HARNESS_CONFIG_JSON when no instance config', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    expect(script).not.toContain('HARNESS_CONFIG_JSON');
  });

  it('a control node (Queen) runs the loop UNSCOPED (P-016)', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'queen-h1', environment: baseEnv, controlNode: true });
    expect(script).toContain("PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='*'");
  });

  it('an execution frame scopes the loop to its one harness', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'papercup', environment: baseEnv });
    expect(script).toContain("PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='papercup'");
  });

  // ── desktop capability (hive-frame-desktops-live-view P-001/P-002/P-005) ──

  it('no desktop knob → no desktop section, no display env', () => {
    const { steps, script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    expect(steps).not.toContain('desktop');
    expect(script).not.toContain('Xvfb');
    expect(script).not.toContain('PAPERCUSP_DESKTOP_DISPLAYS');
  });

  it('desktop:true emits the section with 4 default displays at :99+n (D-001)', () => {
    const { steps, script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      desktop: true,
    });
    expect(steps).toContain('desktop');
    expect(script).toContain('xvfb openbox x11vnc xdotool ffmpeg x11-utils socat');
    for (const d of [99, 100, 101, 102]) {
      expect(script).toContain(`( Xvfb :${d} -screen 0 '1920x1080x24' -nolisten tcp >/var/log/papercusp-desktop/xvfb-${d}.log 2>&1 & )`);
      expect(script).toContain(`DISPLAY=:${d} openbox`);
    }
    expect(script).not.toContain('Xvfb :103');
  });

  it('desktop object form tunes the pool (displays + geometry)', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      desktop: { displays: 2, geometry: '1280x800x24' },
    });
    expect(script).toContain("Xvfb :99 -screen 0 '1280x800x24'");
    expect(script).toContain('Xvfb :100');
    expect(script).not.toContain('Xvfb :101');
  });

  it('desktop advertises the pool to the orchestrator loop (P-002)', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      desktop: { displays: 3 },
    });
    expect(script).toContain('export PAPERCUSP_DESKTOP_DISPLAY_BASE=99');
    expect(script).toContain('export PAPERCUSP_DESKTOP_DISPLAYS=3');
  });

  it('desktop installs + starts the capture loop (P-005), x11vnc NOT started', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      desktop: true,
    });
    expect(script).toContain("cat > '/usr/local/bin/papercusp-desktop-capture' <<'PAPERCUSP_CAPTURE_EOF'");
    expect(script).toContain('f x11grab'); // the embedded capture loop
    expect(script).toContain('( /usr/local/bin/papercusp-desktop-capture >/var/log/papercusp-desktop/capture.log 2>&1 & )');
    // x11vnc is on-demand (Phase 3) — never a boot-time listener.
    expect(script).not.toMatch(/^\s*\(?\s*x11vnc /m);
  });
});

describe('the emitted bootstrap is valid bash', () => {
  // Matrix rather than one case: the desktop/GL section is conditional, so a syntax error
  // introduced there is invisible to any configuration that omits it.
  const configs: Array<{ label: string; opts: Parameters<typeof buildFrameBootstrap>[0] }> = [
    { label: 'minimal', opts: { harnessSlug: 'papercup' } },
    { label: 'desktop: true', opts: { harnessSlug: 'papercup', desktop: true } },
    {
      label: 'desktop with custom geometry',
      opts: { harnessSlug: 'papercup', desktop: { displays: 2, geometry: '1280x1024x24' } },
    },
    {
      label: 'full coding frame with desktop',
      opts: {
        harnessSlug: 'papercup',
        repoUrl: 'https://github.com/acme/repo.git',
        desktop: true,
        claudeCredentialsRemotePath: '/root/creds.json',
        environment: {
          ...baseEnv,
          setup: ['nvm install 22'],
          install: ['npm ci'],
          services: [{ name: 'redis', command: 'redis-server', port: 6379 }],
          env: { NODE_ENV: 'production' },
        },
      },
    },
  ];

  it('CONTROL: assertParses rejects the exact shape that broke the GL section', () => {
    // A permanent deliberately-wrong control, so the guard above is never a check that has
    // only ever been seen to pass. This is the real defect verbatim: a `case` pattern whose
    // marker contains an unquoted space. Bash rejects it at PARSE time, which is why no
    // amount of `toContain` assertions could have caught it.
    expect(() =>
      assertParses('case "$x" in\n  *llvmpipe*|*software rasterizer*) ;;\nesac\n', 'known-bad'),
    ).toThrow(/not valid bash/);

    // ...and the corrected form, which is what the emitter now produces, must parse.
    expect(() =>
      assertParses('case "$x" in\n  *llvmpipe*|*"software rasterizer"*) ;;\nesac\n', 'known-good'),
    ).not.toThrow();
  });

  for (const { label, opts } of configs) {
    it(`parses: ${label}`, () => {
      assertParses(buildFrameBootstrap(opts).script, label);
    });
  }

  it('installs the mesa packages the desktop needs to paint at all', () => {
    // A frame is GPU-less, so the software rasterizer in libgl1-mesa-dri IS its GL. Without
    // it every GTK/WebKitGTK capture is blank regardless of what the app did.
    const { script } = buildFrameBootstrap({ harnessSlug: 'papercup', desktop: true });
    expect(script).toContain('libgl1-mesa-dri');
    expect(script).toContain('mesa-utils');
    expect(script).toContain('PAPERCUSP_GL_TIER');
  });

  it('does not emit the GL probe when no desktop was requested', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'papercup' });
    expect(script).not.toContain('PAPERCUSP_GL_TIER');
    expect(script).not.toContain('libgl1-mesa-dri');
  });
});
