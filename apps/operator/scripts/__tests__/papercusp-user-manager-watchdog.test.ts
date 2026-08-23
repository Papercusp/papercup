import { describe, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SYSTEMD_DIR = join(__dirname, "..", "systemd");
const SCRIPT = join(SYSTEMD_DIR, "papercusp-user-manager-watchdog.sh");
const SERVICE = join(SYSTEMD_DIR, "papercusp-user-manager-watchdog.service");
const TIMER = join(SYSTEMD_DIR, "papercusp-user-manager-watchdog.timer");
const README = join(SYSTEMD_DIR, "README.md");

interface RunOptions {
  now: number;
  state: string;
  linger?: string;
  startFails?: boolean;
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "papercusp-user-manager-watchdog-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "run");
  const managerState = join(dir, "manager-state");
  const logPath = join(dir, "systemctl.log");
  const marker = join(stateDir, "user-1000.down-since");
  await mkdir(binDir);
  await mkdir(stateDir);
  await writeFile(logPath, "");

  await writeFile(
    join(binDir, "loginctl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      '[[ "$1" == "show-user" ]] || exit 2',
      'printf "%s\\n" "${STUB_LINGER:-yes}"',
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
      'case "$1" in',
      '  show) cat "$SYSTEMCTL_STATE" ;;',
      "  start)",
      '    [[ "${STUB_START_FAIL:-0}" == "1" ]] && exit 1',
      '    printf "active\\n" > "$SYSTEMCTL_STATE"',
      "    ;;",
      "  is-active)",
      '    [[ "$(cat "$SYSTEMCTL_STATE")" == "active" ]]',
      "    ;;",
      "  *) exit 2 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    marker,
    logPath,
    async run(options: RunOptions) {
      await writeFile(managerState, options.state + "\n");
      return spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: binDir + ":" + (process.env.PATH ?? ""),
          SYSTEMCTL_LOG: logPath,
          SYSTEMCTL_STATE: managerState,
          STUB_LINGER: options.linger ?? "yes",
          STUB_START_FAIL: options.startFails ? "1" : "0",
          PAPERCUSP_USER_MANAGER_WATCHDOG_UID: "1000",
          PAPERCUSP_USER_MANAGER_WATCHDOG_GRACE_SEC: "60",
          PAPERCUSP_USER_MANAGER_WATCHDOG_STATE_DIR: stateDir,
          PAPERCUSP_USER_MANAGER_WATCHDOG_NOW_SEC: String(options.now),
        },
      });
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("papercusp-user-manager-watchdog.sh", () => {
  it("clears stale evidence and does nothing while the manager is active", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.marker, "1\n");

    const result = await fixture.run({ now: 1_000, state: "active" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("healthy: user@1000.service is active");
    expect(await exists(fixture.marker)).toBe(false);
    expect(await readFile(fixture.logPath, "utf8")).not.toContain(
      "start user@1000.service",
    );
    await fixture.cleanup();
  });

  it("never starts a manager when linger is not enabled", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.marker, "1\n");

    const result = await fixture.run({
      now: 1_000,
      state: "inactive",
      linger: "no",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("does not have linger enabled");
    expect(await exists(fixture.marker)).toBe(false);
    expect(await readFile(fixture.logPath, "utf8")).toBe("");
    await fixture.cleanup();
  });

  it("resets the grace window during a deliberate manager transition", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.marker, "1\n");

    const result = await fixture.run({ now: 1_000, state: "deactivating" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "suppress: user@1000.service is deactivating",
    );
    expect(await exists(fixture.marker)).toBe(false);
    expect(await readFile(fixture.logPath, "utf8")).not.toContain(
      "start user@1000.service",
    );
    await fixture.cleanup();
  });

  it("requires a full grace interval before starting and verifying the manager", async () => {
    const fixture = await makeFixture();

    expect((await fixture.run({ now: 1_000, state: "inactive" })).status).toBe(
      0,
    );
    expect(await readFile(fixture.marker, "utf8")).toBe("1000\n");
    expect((await fixture.run({ now: 1_059, state: "inactive" })).status).toBe(
      0,
    );
    expect(await readFile(fixture.logPath, "utf8")).not.toContain(
      "start user@1000.service",
    );

    const recovered = await fixture.run({ now: 1_060, state: "inactive" });

    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain("restored: user@1000.service is active");
    expect(await exists(fixture.marker)).toBe(false);
    expect(await readFile(fixture.logPath, "utf8")).toContain(
      "start user@1000.service\n",
    );
    await fixture.cleanup();
  });

  it("fails loudly and retains evidence when the manager cannot be started", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.marker, "900\n");

    const result = await fixture.run({
      now: 1_000,
      state: "failed",
      startFails: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("systemctl start user@1000.service failed");
    expect(await readFile(fixture.marker, "utf8")).toBe("900\n");
    await fixture.cleanup();
  });
});

describe("papercusp user-manager watchdog units", () => {
  it("runs from the system manager every minute with persistent scheduling and a preserved runtime marker", async () => {
    const [service, timer] = await Promise.all([
      readFile(SERVICE, "utf8"),
      readFile(TIMER, "utf8"),
    ]);

    expect(service).toContain("User=root");
    expect(service).toContain("PAPERCUSP_USER_MANAGER_WATCHDOG_UID=1000");
    expect(service).toContain("PAPERCUSP_USER_MANAGER_WATCHDOG_GRACE_SEC=60");
    expect(service).toContain("RuntimeDirectoryPreserve=yes");
    expect(service).toContain(
      "ExecStart=/etc/systemd/system/papercusp-user-manager-watchdog.sh",
    );
    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=papercusp-user-manager-watchdog.service");
  });

  it("installs root-owned copies instead of executing user-writable checkout symlinks", async () => {
    const readme = await readFile(README, "utf8");

    expect(readme).toContain(
      "sudo install -o root -g root -m 0755 papercusp-user-manager-watchdog.sh",
    );
    expect(readme).toContain(
      "sudo install -o root -g root -m 0644 papercusp-user-manager-watchdog.service",
    );
    expect(readme).toContain(
      "sudo install -o root -g root -m 0644 papercusp-user-manager-watchdog.timer",
    );
    expect(readme).not.toContain(
      'ln -sfn "$(pwd)/papercusp-user-manager-watchdog',
    );
  });
});
