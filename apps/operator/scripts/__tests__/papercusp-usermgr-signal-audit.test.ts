import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SYSTEMD_DIR = join(__dirname, "..", "systemd");
const SCRIPT =
  process.env.PROBE_SCRIPT ??
  join(SYSTEMD_DIR, "papercusp-usermgr-signal-audit.sh");
const SERVICE = join(SYSTEMD_DIR, "papercusp-usermgr-signal-audit.service");
const TIMER = join(SYSTEMD_DIR, "papercusp-usermgr-signal-audit.timer");

const KEY = "usermgr_signal";

interface RunOptions {
  /** MainPID that `systemctl show` reports. "0" means the manager is down. */
  mainPid: string;
  addFails?: boolean;
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "papercusp-usermgr-signal-audit-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "run");
  const rules = join(dir, "audit-rules");
  const auditLog = join(dir, "auditctl.log");
  await mkdir(binDir);
  await mkdir(stateDir);
  await writeFile(rules, "");
  await writeFile(auditLog, "");

  await writeFile(
    join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "${STUB_MAIN_PID:-0}"',
    ].join("\n"),
    { mode: 0o755 },
  );

  // Reproduces the parts of auditctl this script depends on: `-l` renders the
  // target arg in HEX, which is what the script's presence check greps for.
  await writeFile(
    join(binDir, "auditctl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "$*" >> "$AUDITCTL_LOG"',
      "pid=''",
      'for a in "$@"; do case "$a" in a0=*) pid="${a#a0=}" ;; esac; done',
      'case "$1" in',
      '  -l) cat "$AUDITCTL_RULES" ;;',
      "  -a)",
      '    [[ "${STUB_ADD_FAIL:-0}" == "1" ]] && exit 1',
      '    printf -- "-a always,exit -F arch=b64 -S kill,tgkill -F a0=0x%X -F key=%s\\n" \\',
      `      "$pid" "${KEY}" >> "$AUDITCTL_RULES"`,
      "    ;;",
      "  -d)",
      '    hex="$(printf "%X" "$pid")"',
      `    grep -vF -- "a0=0x\${hex} -F key=${KEY}" "$AUDITCTL_RULES" > "$AUDITCTL_RULES.tmp" || true`,
      '    mv "$AUDITCTL_RULES.tmp" "$AUDITCTL_RULES"',
      "    ;;",
      "  *) exit 2 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    rules,
    auditLog,
    armedFile: join(stateDir, "armed-pid"),
    run(options: RunOptions) {
      return spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: binDir + ":" + (process.env.PATH ?? ""),
          AUDITCTL_RULES: rules,
          AUDITCTL_LOG: auditLog,
          STUB_MAIN_PID: options.mainPid,
          STUB_ADD_FAIL: options.addFails ? "1" : "0",
          PAPERCUSP_USERMGR_SIGNAL_AUDIT_UID: "1000",
          PAPERCUSP_USERMGR_SIGNAL_AUDIT_STATE_DIR: stateDir,
          PAPERCUSP_USERMGR_SIGNAL_AUDIT_KEY: KEY,
        },
      });
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("papercusp-usermgr-signal-audit.sh", () => {
  it("arms a pid-pinned rule for the live manager and records what it armed", async () => {
    const fixture = await makeFixture();

    const result = fixture.run({ mainPid: "209466" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("armed: signals to user@1000.service");
    // 209466 === 0x3323A: the rule must target the manager, in the hex form
    // auditctl actually renders.
    expect(await readFile(fixture.rules, "utf8")).toContain(
      `-F a0=0x3323A -F key=${KEY}`,
    );
    expect(await readFile(fixture.armedFile, "utf8")).toBe("209466\n");
    await fixture.cleanup();
  });

  it("is idempotent while the pid is unchanged and the rule is still loaded", async () => {
    const fixture = await makeFixture();
    expect(fixture.run({ mainPid: "209466" }).status).toBe(0);

    const second = fixture.run({ mainPid: "209466" });

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already armed");
    const rules = await readFile(fixture.rules, "utf8");
    expect(rules.trim().split("\n")).toHaveLength(1);
    await fixture.cleanup();
  });

  it("re-arms on the new pid and drops the stale rule when the manager restarts", async () => {
    const fixture = await makeFixture();
    expect(fixture.run({ mainPid: "4090" }).status).toBe(0);

    const restarted = fixture.run({ mainPid: "209466" });

    expect(restarted.status).toBe(0);
    const rules = await readFile(fixture.rules, "utf8");
    expect(rules).toContain(`-F a0=0x3323A -F key=${KEY}`);
    // 4090 === 0xFFA. One dead rule per manager restart would otherwise
    // accumulate for the life of the boot.
    expect(rules).not.toContain(`-F a0=0xFFA -F key=${KEY}`);
    expect(await readFile(fixture.auditLog, "utf8")).toContain("-d always,exit");
    await fixture.cleanup();
  });

  it("re-adds the rule when auditd has been restarted and flushed it", async () => {
    const fixture = await makeFixture();
    expect(fixture.run({ mainPid: "209466" }).status).toBe(0);
    await writeFile(fixture.rules, ""); // auditd restart flushes the ruleset

    const result = fixture.run({ mainPid: "209466" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("armed: signals to user@1000.service");
    expect(await readFile(fixture.rules, "utf8")).toContain(
      `-F a0=0x3323A -F key=${KEY}`,
    );
    await fixture.cleanup();
  });

  it("skips without arming anything while the manager is down", async () => {
    const fixture = await makeFixture();

    const result = fixture.run({ mainPid: "0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no main process to audit");
    expect(await readFile(fixture.rules, "utf8")).toBe("");
    await fixture.cleanup();
  });

  it("fails loudly when the rule cannot be armed", async () => {
    const fixture = await makeFixture();

    const result = fixture.run({ mainPid: "209466", addFails: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not arm the audit rule");
    await fixture.cleanup();
  });
});

describe("papercusp usermgr-signal-audit units", () => {
  it("runs as root every minute with the netlink access auditctl requires", async () => {
    const [service, timer] = await Promise.all([
      readFile(SERVICE, "utf8"),
      readFile(TIMER, "utf8"),
    ]);

    expect(service).toContain("User=root");
    expect(service).toContain(
      "ExecStart=/etc/systemd/system/papercusp-usermgr-signal-audit.sh",
    );
    expect(service).toContain("RuntimeDirectoryPreserve=yes");
    // auditctl speaks NETLINK_AUDIT; confining this unit to AF_UNIX the way the
    // recovery watchdog is confined would silently break every arming run.
    expect(service).toContain("AF_NETLINK");
    expect(service).toContain("CAP_AUDIT_CONTROL");
    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=papercusp-usermgr-signal-audit.service");
  });
});
