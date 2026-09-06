import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "apps/operator/scripts/systemd/deploy-cloud-portal.sh");
const TEMPLATE = join(ROOT, "apps/operator/scripts/systemd/papercusp-cloud-portal.service.in");
const README = join(ROOT, "apps/operator/scripts/systemd/README.md");

interface Fixture {
  dir: string;
  portalRoot: string;
  runtimeRoot: string;
  unitDir: string;
  binDir: string;
  logPath: string;
  analyzeLogPath: string;
  procRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-"));
  const portalRoot = join(dir, "portal app");
  const runtimeRoot = join(dir, ".portal-runtime", "portal app");
  const nextDir = join(portalRoot, "node_modules", ".bin");
  const releaseDir = join(runtimeRoot, "releases", "build-one");
  const currentDir = runtimeRoot;
  const unitDir = join(dir, "systemd", "user");
  const tempDir = join(dir, "tmp");
  const binDir = join(dir, "bin");
  const procRoot = join(dir, "proc");
  mkdirSync(join(portalRoot, "scripts"), { recursive: true });
  mkdirSync(nextDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  symlinkSync(join("releases", "build-one"), join(currentDir, "current"), "dir");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(procRoot, "4242"), { recursive: true });
  mkdirSync(join(procRoot, "4242", "task", "4242"), { recursive: true });
  mkdirSync(join(procRoot, "4343"), { recursive: true });
  writeFileSync(join(portalRoot, "package.json"), '{"name":"portal-fixture"}\n');
  writeFileSync(join(nextDir, "next"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(nextDir, "next"), 0o755);
  // deploy-cloud-portal.sh proves `current` was built from $PORTAL_ROOT by reading the
  // `join(root, "<checkout-relative server.js>")` a real standalone entry embeds and
  // refuses the handoff otherwise (EI-22123385977067109) — so the fixture's entry must
  // name this fixture's own portal root, not be an empty module.
  writeFileSync(
    join(releaseDir, "standalone-entry.mjs"),
    `import { join } from "node:path";\nconst root = "/";\nexport default join(root, ${JSON.stringify(
      `${portalRoot.replace(/^\//, "")}/server.js`,
    )});\n`,
  );
  writeFileSync(join(portalRoot, "scripts", "start-web.mjs"), "export {};\n");
  writeFileSync(join(procRoot, "4242", "cmdline"), Buffer.from("node\0old-next-dev\0"));
  // `/proc/<pid>/task/<pid>/children` is newline-free on Linux. The handoff
  // verifier must still consume its final record rather than treating the
  // managed generation as stale and rolling a healthy service back.
  writeFileSync(join(procRoot, "4242", "task", "4242", "children"), "4343");
  symlinkSync(releaseDir, join(procRoot, "4343", "cwd"), "dir");
  return {
    dir,
    portalRoot,
    runtimeRoot,
    unitDir,
    binDir,
    logPath: join(dir, "systemctl.log"),
    analyzeLogPath: join(dir, "systemd-analyze.log"),
    procRoot,
  };
}

function envFor(files: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAPERCUSP_CLOUD_PORTAL_ROOT: files.portalRoot,
    PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
    PAPERCUSP_CLOUD_PORTAL_UNIT_DIR: files.unitDir,
    PAPERCUSP_CLOUD_PORTAL_TMPDIR: join(files.dir, "tmp"),
    PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "0",
    PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE: "/bin/true",
    PAPERCUSP_CLOUD_PORTAL_PROC_ROOT: files.procRoot,
  };
}

function gitCommitAll(portalRoot: string, message: string) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  spawnSync("git", ["init", "-q"], { cwd: portalRoot, env });
  spawnSync("git", ["add", "-A"], { cwd: portalRoot, env });
  spawnSync("git", ["commit", "-q", "-m", message, "--allow-empty"], { cwd: portalRoot, env });
}

function writeReleaseManifest(runtimeRoot: string, publishedAt: string, sourceRootDigest?: string) {
  writeFileSync(
    join(runtimeRoot, "current", ".papercusp-release.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        buildId: "build-one",
        release: "build-one",
        sourceRoot: "/x",
        publishedAt,
        ...(sourceRootDigest ? { sourceRootDigest } : {}),
      },
      null,
      2,
    ) + "\n",
  );
}

// Stands in for the portal checkout's scripts/release-source-digest.mjs: the deploy
// script runs `$NODE_BIN <portalRoot>/scripts/release-source-digest.mjs <portalRoot>`
// and reads one hex line from stdout.
function writeDigestCli(portalRoot: string, digest: string) {
  writeFileSync(
    join(portalRoot, "scripts", "release-source-digest.mjs"),
    `process.stdout.write(${JSON.stringify(`${digest}\n`)});\n`,
  );
}

const RELEASE_DIGEST = "c0ffee".repeat(10) + "abcd";

function staleTestSystemctl(files: Fixture): string {
  const systemctl = join(files.binDir, "systemctl");
  writeFileSync(
    systemctl,
    `#!/usr/bin/env bash
set -eu
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  restart) printf '%s\\0%s\\0' node '${files.portalRoot}/scripts/start-web.mjs' > '${files.procRoot}/4242/cmdline'; exit 0 ;;
  is-active) exit 0 ;;
  show) printf '4242\n'; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(systemctl, 0o755);
  return systemctl;
}

function run(files: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...envFor(files), ...extraEnv },
  });
}

describe("Cloud Portal systemd deployment contract", () => {
  it("ships the documented handoff entrypoint as a directly executable script", () => {
    const result = spawnSync(SCRIPT, ["--help"], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: deploy-cloud-portal.sh [--render-only|--install-only|--handoff]",
    );
  });

  it("renders machine-specific paths with systemd escaping and keeps the source template neutral", () => {
    const files = fixture();
    try {
      const result = run(files, ["--render-only"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`WorkingDirectory=${files.portalRoot.replaceAll(" ", "\\ ")}`);
      expect(result.stdout).toContain(`ExecStart=${process.execPath} `);
      expect(result.stdout).toContain("Environment=NODE_ENV=production");
      expect(result.stdout).toContain("Environment=HOSTNAME=127.0.0.1");
      expect(result.stdout).toContain(
        `Environment=PORTAL_RUNTIME_ROOT=${files.runtimeRoot.replaceAll(" ", "\\ ")}`,
      );
      expect(result.stdout).toContain(`EnvironmentFile=-${files.portalRoot.replaceAll(" ", "\\ ")}/.env.local`);
      expect(result.stdout).toContain("scripts/start-web.mjs");
      expect(result.stdout).not.toContain(`${files.portalRoot.replaceAll(" ", "\\ ")}/.portal-runtime`);
      expect(result.stdout).not.toContain("ExecStart=" + process.execPath + " " + files.portalRoot + "/node_modules/.bin/next dev");
      expect(result.stdout).toContain("KillMode=control-group");

      const template = readFileSync(TEMPLATE, "utf8");
      expect(template).toContain("@PORTAL_ROOT@");
      expect(template).toContain("@RUNTIME_ROOT@");
      expect(template).toContain("@NODE@");
      expect(template).not.toMatch(/\/home\/[a-z]/i);
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("atomically installs, verifies, reloads, and enables without starting the backend", () => {
    const files = fixture();
    const systemctl = join(files.binDir, "systemctl");
    const systemdAnalyze = join(files.binDir, "systemd-analyze");
    writeFileSync(
      systemctl,
      `#!/usr/bin/env bash
set -eu
  printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
  shift
case "$1" in
  daemon-reload|enable) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(systemctl, 0o755);
    writeFileSync(
      systemdAnalyze,
      `#!/usr/bin/env bash
set -eu
test "$1" = verify
printf '%s\\n' "$2" > "$ANALYZE_LOG"
case "$2" in
  *.service) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(systemdAnalyze, 0o755);
    try {
      const result = run(files, ["--install-only"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE: systemdAnalyze,
        SYSTEMCTL_LOG: files.logPath,
        ANALYZE_LOG: files.analyzeLogPath,
      });
      expect(result.status, result.stderr).toBe(0);
      const installed = readFileSync(join(files.unitDir, "papercusp-cloud-portal.service"), "utf8");
      expect(installed).toContain("WorkingDirectory=");
      expect(installed).toContain("ExecStart=");
      expect(installed).toContain("Environment=NODE_ENV=production");
      expect(installed).toContain("EnvironmentFile=-");
      expect(installed).toContain("scripts/start-web.mjs");
      expect(readFileSync(files.logPath, "utf8")).toBe(
        "--user daemon-reload\n--user enable papercusp-cloud-portal.service\n",
      );
      expect(result.stdout).toContain("not started");
      expect(readdirSync(files.unitDir)).toEqual(["papercusp-cloud-portal.service"]);
      expect(readdirSync(join(files.dir, "tmp"))).toEqual([]);
      expect(readFileSync(files.analyzeLogPath, "utf8")).toMatch(/\.service\n$/);
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses installation until the standalone production artifact has been built", () => {
    const files = fixture();
    try {
      rmSync(join(files.runtimeRoot, "current", "standalone-entry.mjs"));
      const result = run(files, ["--render-only"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal production artifact is missing");
      expect(result.stderr).toContain("run npm run build first");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("keeps the handoff safety boundary around the validated backend, not the :3081 proxy", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain("validate_legacy_listener");
    expect(script).toContain("START_WEB");
    expect(script).toContain("CURRENT_RELEASE_LINK");
    expect(script).toContain("PORTAL_RUNTIME_ROOT");
    expect(script).toContain('CURRENT_RELEASE_LINK="$PORTAL_RUNTIME_ROOT/current"');
    expect(script).toContain("process_lineage_is_next_dev");
    expect(script).toContain("restore_legacy_listener");
    expect(script).toContain("managed_unit_runs_current_artifact");
    expect(script).toContain('cd -- "$PORTAL_ROOT"');
    expect(script).toContain('TEMP_DIR="${PAPERCUSP_CLOUD_PORTAL_TMPDIR:-${TMPDIR:-/tmp}}"');
    expect(script).toContain('mktemp "$TEMP_DIR/.${UNIT_NAME}.tmp.XXXXXX.service"');
    expect(script).not.toContain('mktemp "$UNIT_DIR/.${UNIT_NAME}.tmp.XXXXXX.service"');
    expect(script).toContain('TEMP_DIR="/var/tmp"');
    expect(script).toContain("health_check \"$PORTAL_PORT\"");
    expect(script).toContain("systemctl_user stop \"$UNIT_NAME\"");
    expect(script).toContain("papercusp-cloud-portal-3081.service");
    expect(script).not.toMatch(/systemctl_user\s+stop[^\n]*3081/);
    expect(script.indexOf("validate_legacy_listener")).toBeLessThan(script.indexOf("stop_legacy_listener"));
    expect(script.indexOf("restore_legacy_listener")).toBeGreaterThan(script.indexOf("start_managed"));
  });

  it("restarts an active managed stale generation instead of misreporting it as current", () => {
    const files = fixture();
    const systemctl = join(files.binDir, "systemctl");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  restart) printf '%s\\0%s\\0' node '${files.portalRoot}/scripts/start-web.mjs' > '${files.procRoot}/4242/cmdline'; exit 0 ;;
  is-active) exit 0 ;;
  show) printf '4242\n'; exit 0 ;;
  *) exit 1 ;;
esac
`);
    chmodSync(systemctl, 0o755);
    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        SYSTEMCTL_LOG: files.logPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("running a stale command; restarting onto the standalone artifact");
      expect(result.stdout).toContain("runs the standalone production artifact and passed health check");
      expect(readFileSync(files.logPath, "utf8")).toContain("--user restart papercusp-cloud-portal.service\n");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("suppresses transient curl noise and reports one bounded health failure diagnostic", () => {
    const transient = fixture();
    const transientSystemctl = staleTestSystemctl(transient);
    const transientCurl = join(transient.binDir, "curl-transient");
    const transientState = join(transient.dir, "curl-transient-state");
    writeFileSync(
      transientCurl,
      `#!/usr/bin/env bash
set -eu
if [[ ! -e '${transientState}' ]]; then
  : > '${transientState}'
  printf '%s\\n' 'curl: (7) transient fixture noise' >&2
  exit 7
fi
exit 0
`,
    );
    chmodSync(transientCurl, 0o755);

    try {
      const result = run(transient, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: transientSystemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: transientCurl,
        PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("curl: (7) transient fixture noise");
      expect(result.stdout).toContain("handoff complete: papercusp-cloud-portal.service runs the standalone production artifact");
    } finally {
      rmSync(transient.dir, { recursive: true, force: true });
    }

    const failing = fixture();
    const failingSystemctl = join(failing.binDir, "systemctl-failing-health");
    const failingCurl = join(failing.binDir, "curl-failing-health");
    writeFileSync(
      failingSystemctl,
      `#!/usr/bin/env bash
set -eu
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  is-active) exit 1 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(failingSystemctl, 0o755);
    writeFileSync(
      failingCurl,
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' 'curl: (7) final fixture noise' >&2
exit 7
`,
    );
    chmodSync(failingCurl, 0o755);

    try {
      const result = run(failing, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: failingSystemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: failingCurl,
        PAPERCUSP_CLOUD_PORTAL_SS: "/bin/false",
        PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("curl: (7) final fixture noise");
      expect(result.stderr).toContain(
        "cloud-portal: ERROR: health check failed for http://127.0.0.1:3801/ after 2 attempt(s)",
      );
      expect(result.stderr.match(/health check failed for/g)).toHaveLength(1);
    } finally {
      rmSync(failing.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff onto a stale current release when the checkout has moved on (WI-2141210)", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("commit newer than the release");
      expect(result.stderr).toContain("PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff when the checkout has uncommitted changes, even with a future-dated release", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z");
      writeFileSync(join(files.portalRoot, "package.json"), '{"name":"portal-fixture","dirty":true}\n');
      const result = run(files, ["--handoff"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("uncommitted changes");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("deploys cleanly when the release postdates the checkout's last commit", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("deploys a stale current release when explicitly overridden (deliberate rollback)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE: "1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("WARNING: current release looks STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("judges freshness by CONTENT digest: a byte-identical checkout deploys even when git-sync left it dirty with an older publishedAt (EI-22388584299827941)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      // Both legacy stale signals are present: an old publishedAt AND uncommitted changes.
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z", RELEASE_DIGEST);
      writeDigestCli(files.portalRoot, RELEASE_DIGEST);
      writeFileSync(join(files.portalRoot, "package.json"), '{"name":"portal-fixture","dirty":true}\n');
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
      expect(result.stdout).toContain("source digest matches");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff when the checkout's content digest differs from the release's, naming both digests", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      // A future-dated, clean-looking release: the git heuristic alone would pass it.
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z", RELEASE_DIGEST);
      writeDigestCli(files.portalRoot, "d".repeat(64));
      gitCommitAll(files.portalRoot, "add digest cli");
      const result = run(files, ["--handoff"], { PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("source digest");
      expect(result.stderr).toContain("differs from the release's");
      expect(result.stderr).toContain(RELEASE_DIGEST.slice(0, 12));
      expect(result.stderr).toContain("PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("falls back to the git heuristic when the manifest carries a digest but the checkout has no digest CLI", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z", RELEASE_DIGEST);
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
      expect(result.stdout).not.toContain("source digest matches");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("does not check staleness when the checkout is not a git repository (skip, not refuse)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("documents the separate proxy and the managed cgroup verification", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("deploy-cloud-portal.sh --handoff");
    expect(readme).toContain("papercusp-cloud-portal-3081.service");
    expect(readme).toContain("ControlGroup");
    expect(readme).toContain("bounded outage window");
  });
});
