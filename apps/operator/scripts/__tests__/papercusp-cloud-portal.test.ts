import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  unitDir: string;
  binDir: string;
  logPath: string;
  analyzeLogPath: string;
  procRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-"));
  const portalRoot = join(dir, "portal app");
  const nextDir = join(portalRoot, "node_modules", ".bin");
  const standaloneDir = join(portalRoot, ".next", "standalone");
  const unitDir = join(dir, "systemd", "user");
  const tempDir = join(dir, "tmp");
  const binDir = join(dir, "bin");
  const procRoot = join(dir, "proc");
  mkdirSync(nextDir, { recursive: true });
  mkdirSync(standaloneDir, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(procRoot, "4242"), { recursive: true });
  writeFileSync(join(portalRoot, "package.json"), '{"name":"portal-fixture"}\n');
  writeFileSync(join(nextDir, "next"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(nextDir, "next"), 0o755);
  writeFileSync(join(standaloneDir, "standalone-entry.mjs"), "export {};\n");
  writeFileSync(join(procRoot, "4242", "cmdline"), Buffer.from("node\0old-next-dev\0"));
  return {
    dir,
    portalRoot,
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

function run(files: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...envFor(files), ...extraEnv },
  });
}

describe("Cloud Portal systemd deployment contract", () => {
  it("renders machine-specific paths with systemd escaping and keeps the source template neutral", () => {
    const files = fixture();
    try {
      const result = run(files, ["--render-only"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`WorkingDirectory=${files.portalRoot.replaceAll(" ", "\\ ")}`);
      expect(result.stdout).toContain(`ExecStart=${process.execPath} `);
      expect(result.stdout).toContain("Environment=NODE_ENV=production");
      expect(result.stdout).toContain("Environment=HOSTNAME=127.0.0.1");
      expect(result.stdout).toContain(`EnvironmentFile=-${files.portalRoot.replaceAll(" ", "\\ ")}/.env.local`);
      expect(result.stdout).toContain(".next/standalone/standalone-entry.mjs");
      expect(result.stdout).not.toContain("ExecStart=" + process.execPath + " " + files.portalRoot + "/node_modules/.bin/next dev");
      expect(result.stdout).toContain("KillMode=control-group");

      const template = readFileSync(TEMPLATE, "utf8");
      expect(template).toContain("@PORTAL_ROOT@");
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
      expect(installed).toContain("standalone-entry.mjs");
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
      rmSync(join(files.portalRoot, ".next", "standalone", "standalone-entry.mjs"));
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
    expect(script).toContain("STANDALONE_ENTRY");
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

  it("restarts an active managed dev generation instead of misreporting it as current", () => {
    const files = fixture();
    const systemctl = join(files.binDir, "systemctl");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|restart|stop|reset-failed|start) exit 0 ;;
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

  it("documents the separate proxy and the managed cgroup verification", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("deploy-cloud-portal.sh --handoff");
    expect(readme).toContain("papercusp-cloud-portal-3081.service");
    expect(readme).toContain("ControlGroup");
    expect(readme).toContain("bounded outage window");
  });
});
