/**
 * Frame bootstrap generator (`cloud-deployment-layer-2026-06-06` P-010/P-011).
 *
 * Pure function: turns a deployment config + the blueprint's environment spec
 * (P-007) into the bash script the driver runs ON a provisioned frame to stand up
 * the papercusp runtime — generalizing the `deploy/HARNESS-ON-HETZNER.md`
 * sidecar-runner from a baked Docker image to an on-demand VM/metal bootstrap.
 *
 * Per the ratified D-006/D-007, a frame is SELF-SUFFICIENT: it runs its OWN
 * orchestrator loop (D-006) against its OWN embedded-pg that federates via the
 * peer-log (D-007). So the script installs the runtime + agent CLIs + Meridian,
 * mounts the per-frame Claude credentials (P-011), runs the env spec's
 * setup/install/build, starts embedded-pg + applies migrations, and launches the
 * frame's orchestrator loop scoped to the one harness it hosts.
 *
 * It returns the script PLUS a `steps` list (the section ids) so the driver +
 * tests can reason about / assert the bootstrap without parsing bash. The exact
 * runtime-delivery (clone+build vs a prebuilt bundle) is a parameter — infra's
 * choice — so this generator stays correct-by-construction and unit-testable
 * without a live frame.
 */
import type { BlueprintEnvironment } from '@papercusp/orchestrator/blueprint';

export interface FrameBootstrapOpts {
  /** The harness this frame hosts. */
  harnessSlug: string;
  /** Git URL of the harness repo to clone (omit for a repo-less harness). */
  repoUrl?: string;
  /** Branch/ref to check out (default `main`). */
  repoRef?: string;
  /** The blueprint environment spec (P-007) — setup/install/build/run/services/ports/env. */
  environment?: BlueprintEnvironment;
  /** Node major to install (default 22). */
  nodeVersion?: number;
  /** Agent backend the frame's loop spawns (default `omp` via Meridian). */
  agentBackend?: 'omp' | 'claude' | 'codex';
  /** D-007: run the frame's own embedded-pg, federating via the peer-log (default true). */
  embeddedPg?: boolean;
  /** D-006: run the frame's own orchestrator loop (default true). */
  orchestratorOnFrame?: boolean;
  /** P-011: path on the frame where the Claude credentials were staged before this runs. */
  claudeCredentialsRemotePath?: string;
  /** P-011 token channel: path on the frame where a long-lived OAuth token
   *  (`claude setup-token` output) was staged — installed to `~/.papercusp/claude-token`
   *  and exported as `CLAUDE_CODE_OAUTH_TOKEN` for everything the script starts. */
  claudeTokenRemotePath?: string;
  /** Install root on the frame (default `/opt/papercusp`). */
  installRoot?: string;
  /** Commands that install the papercusp RUNTIME on the frame (clone+build, or fetch a
   *  prebuilt bundle). Parameterized — infra's choice. A sane default is provided. */
  runtimeSetup?: string[];
  /** Extra NON-SECRET env exported for the run (merged over environment.env). */
  env?: Record<string, string>;
  /** The harness's per-install instance config as JSON — exported as
   *  HARNESS_CONFIG_JSON so the frame's runtime reads it via the env-transport
   *  (P-008; the frame has no local config.json). */
  instanceConfigJson?: string;
  /** Control node (the Queen — P-016/D-008 `dedicated` placement): run the operator
   *  loop UNSCOPED (supervises across frames via coordination) rather than scoped to
   *  one harness. */
  controlNode?: boolean;
}

/** The bootstrap section ids, in run order — the observable contract. */
export const FRAME_BOOTSTRAP_STEPS = [
  'preflight',
  'node',
  'agent-clis',
  'runtime',
  'repo',
  'credentials',
  'embedded-pg',
  'env-setup',
  'env-install',
  'env-build',
  'services',
  'orchestrator-loop',
] as const;
export type FrameBootstrapStep = (typeof FRAME_BOOTSTRAP_STEPS)[number];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function section(id: FrameBootstrapStep, title: string, lines: string[]): string {
  return [`# ── ${id}: ${title} ──`, `log ${shq(id)}`, ...lines, ''].join('\n');
}

export interface FrameBootstrapResult {
  script: string;
  /** The sections actually emitted (some are skipped by opts). */
  steps: FrameBootstrapStep[];
}

export function buildFrameBootstrap(opts: FrameBootstrapOpts): FrameBootstrapResult {
  const node = opts.nodeVersion ?? 22;
  const root = (opts.installRoot ?? '/opt/papercusp').replace(/\/$/, '');
  const repoDir = `${root}/${opts.harnessSlug}`;
  const backend = opts.agentBackend ?? 'omp';
  const embeddedPg = opts.embeddedPg !== false;
  const orchestratorOnFrame = opts.orchestratorOnFrame !== false;
  const credPath = opts.claudeCredentialsRemotePath;
  const tokenPath = opts.claudeTokenRemotePath;
  const envSpec = opts.environment;
  const mergedEnv = { ...(envSpec?.env ?? {}), ...(opts.env ?? {}) };

  const emitted: FrameBootstrapStep[] = [];
  const blocks: string[] = [];
  const add = (id: FrameBootstrapStep, title: string, lines: string[]) => {
    emitted.push(id);
    blocks.push(section(id, title, lines));
  };

  add('preflight', 'OS packages', [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    'apt-get install -y --no-install-recommends git curl ca-certificates build-essential python3 jq ripgrep openssh-client',
  ]);

  add('node', `Node.js ${node}`, [
    `if ! node -v 2>/dev/null | grep -q "^v${node}"; then`,
    `  curl -fsSL https://deb.nodesource.com/setup_${node}.x | bash -`,
    '  apt-get install -y nodejs',
    'fi',
    'npm i -g tsx',
  ]);

  // Default agent CLIs: Meridian (OAuth router on :3456) + omp + the claude CLI
  // fallback (HARNESS-ON-HETZNER). Both backends read the mounted credentials.
  add('agent-clis', 'agent CLIs + Meridian', [
    'npm i -g @rynfar/meridian @oh-my-pi/pi-coding-agent',
    '# claude CLI (fallback backend + vendors the OAuth credentials Meridian reads)',
    'curl -fsSL https://claude.ai/install.sh | bash || npm i -g @anthropic-ai/claude-code',
    backend === 'omp'
      ? '( meridian >/var/log/meridian.log 2>&1 & ) # OAuth router on :3456'
      : '# backend is not omp — Meridian not started',
  ]);

  add('runtime', 'papercusp runtime', [
    `mkdir -p ${shq(root)}`,
    ...(opts.runtimeSetup ?? [
      '# Default runtime delivery: clone + install the operator runtime. Prod may',
      '# swap this for a prebuilt bundle fetch (set opts.runtimeSetup).',
      `git clone --depth 1 https://github.com/Papercusp/papercup.git ${shq(`${root}/runtime`)} || true`,
      `cd ${shq(`${root}/runtime`)} && npm ci --no-audit --no-fund || npm install --no-audit --no-fund`,
    ]),
  ]);

  if (opts.repoUrl) {
    add('repo', 'clone harness repo', [
      `if [ ! -d ${shq(repoDir)}/.git ]; then`,
      `  git clone ${shq(opts.repoUrl)} ${shq(repoDir)}`,
      'fi',
      `cd ${shq(repoDir)} && git fetch --all && git checkout ${shq(opts.repoRef ?? 'main')} && git pull --ff-only || true`,
    ]);
  }

  if (credPath || tokenPath) {
    // P-011: stage the per-frame Claude subscription so this frame has its OWN
    // rate limits — via a credentials bundle (interactive-login channel), a
    // long-lived OAuth token (`claude setup-token`; the automated channel), or both.
    const lines: string[] = [];
    if (credPath) {
      // The operator scp's the credentials to `credPath` BEFORE this runs; here we
      // install them where both omp (via Meridian) + claude read.
      lines.push(
        'mkdir -p "$HOME/.claude" && chmod 700 "$HOME/.claude"',
        `if [ -f ${shq(credPath)} ]; then`,
        `  install -m 0600 ${shq(credPath)} "$HOME/.claude/.credentials.json"`,
        'else',
        `  echo "WARN: Claude credentials not staged at ${credPath} — agent runs will fail to auth" >&2`,
        'fi',
      );
    }
    if (tokenPath) {
      // Exported here (script-level) so every later section — services + the
      // orchestrator loop and the agents it spawns — inherits it.
      lines.push(
        `if [ -f ${shq(tokenPath)} ]; then`,
        `  mkdir -p "$HOME/.papercusp" && install -m 0600 ${shq(tokenPath)} "$HOME/.papercusp/claude-token"`,
        '  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.papercusp/claude-token")"',
        'else',
        `  echo "WARN: Claude OAuth token not staged at ${tokenPath} — agent runs will fail to auth" >&2`,
        'fi',
      );
    }
    add('credentials', 'mount Claude subscription (P-011)', lines);
  }

  if (embeddedPg) {
    // D-007: the frame runs its OWN embedded-pg, federating via the peer-log.
    add('embedded-pg', 'embedded Postgres + migrations (D-007)', [
      `cd ${shq(`${root}/runtime`)}`,
      'npm run --workspace @papercusp/embedded-postgres-server start >/var/log/embedded-pg.log 2>&1 &',
      '# the embedded-pg boot runner applies libs/papercusp/libs/db/sql/<NNN>-*.sql on start',
      'for i in $(seq 1 30); do [ -f "$HOME/.papercusp/embedded-pg.json" ] && break; sleep 2; done',
    ]);
  }

  const cdRun = opts.repoUrl ? `cd ${shq(repoDir)}` : `cd ${shq(root)}`;
  if (envSpec?.setup?.length) add('env-setup', 'env spec: setup', [cdRun, ...envSpec.setup]);
  if (envSpec?.install?.length) add('env-install', 'env spec: install', [cdRun, ...envSpec.install]);
  if (envSpec?.build?.length) add('env-build', 'env spec: build', [cdRun, ...envSpec.build]);

  if (envSpec?.services?.length) {
    add('services', 'background services', [
      cdRun,
      ...envSpec.services.map(
        (s) => `( ${s.command} ) >/var/log/svc-${s.name}.log 2>&1 & # ${s.name}${s.port ? ` :${s.port}` : ''}`,
      ),
    ]);
  }

  if (orchestratorOnFrame) {
    // D-006: the frame self-dispatches the agents it hosts. Scope the loop to this
    // one harness; the Queen supervises across frames via coordination, not by
    // running each frame's loop.
    add('orchestrator-loop', 'frame orchestrator loop (D-006)', [
      `cd ${shq(`${root}/runtime`)}`,
      'export PAPERCUSP_DBOS_ORCHESTRATOR=1',
      // Control node (Queen) supervises ACROSS frames → unscoped (`*`); an execution
      // frame self-dispatches only the one harness it hosts (D-006).
      `export PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=${shq(opts.controlNode ? '*' : opts.harnessSlug)}`,
      `export AGENT_BACKEND=${shq(backend === 'omp' ? 'omp' : backend === 'claude' ? 'claude-code' : 'codex')}`,
      // P-008: the frame reads its per-install instance config from env (no config.json file).
      ...(opts.instanceConfigJson ? [`export HARNESS_CONFIG_JSON=${shq(opts.instanceConfigJson)}`] : []),
      ...Object.entries(mergedEnv).map(([k, v]) => `export ${k}=${shq(v)}`),
      '( npm run dev:operator >/var/log/papercusp-operator.log 2>&1 & )',
      // shq() the whole literal so a slug with shell metacharacters can't break
      // out of the echo (consistent with every other interpolation here).
      `echo ${shq('frame orchestrator loop started for harness ' + opts.harnessSlug)}`,
    ]);
  }

  const header = [
    '#!/usr/bin/env bash',
    '# Generated by frame-bootstrap.ts — cloud-deployment-layer P-010/P-011.',
    `# Frame for harness: ${opts.harnessSlug}`,
    'set -euo pipefail',
    'log() { echo "[frame-bootstrap] $1"; }',
    '',
  ].join('\n');

  return { script: header + blocks.join('\n'), steps: emitted };
}
