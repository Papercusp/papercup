import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "apps/operator/scripts/papercusp-dns-reconcile.sh");
const DROPIN = join(
  ROOT,
  "apps/operator/scripts/systemd/papercusp-dns-over-tls.conf",
);
const CHROME_POLICY = join(
  ROOT,
  "apps/operator/scripts/systemd/papercusp-chrome-dns-policy.json",
);
const UNIT_DIR = join(ROOT, "apps/operator/scripts/systemd");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "papercusp-dns-"));
  dirs.push(dir);
  const hosts = join(dir, "hosts");
  const installedDropin = join(dir, "resolved.conf");
  const installedPolicy = join(dir, "chrome-policy.json");
  writeFileSync(
    hosts,
    [
      "127.0.0.1 localhost",
      "192.0.2.8 keep.example papercusp.com # retain the unrelated alias",
      "# ---- BEGIN papercusp-sni-bypass (legacy) ----",
      "127.0.0.11 papercusp.com",
      "127.0.0.12 www.papercusp.com",
      "# ---- END papercusp-sni-bypass ----",
      "203.0.113.7 untouched.example",
      "",
    ].join("\n"),
  );
  return { dir, hosts, installedDropin, installedPolicy };
}

function run(mode: "--apply" | "--check", files: ReturnType<typeof fixture>) {
  return spawnSync("bash", [SCRIPT, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      PAPERCUSP_DNS_TEST_MODE: "1",
      PAPERCUSP_DNS_HOSTS_FILE: files.hosts,
      PAPERCUSP_DNS_RESOLVED_DROPIN: files.installedDropin,
      PAPERCUSP_DNS_EXPECTED_DROPIN: DROPIN,
      PAPERCUSP_CHROME_POLICY: files.installedPolicy,
      PAPERCUSP_CHROME_POLICY_SOURCE: CHROME_POLICY,
    },
  });
}

describe("papercusp direct-DNS reconciler", () => {
  it("removes the whole legacy bypass block and only the targeted mixed-line alias", () => {
    const files = fixture();
    const result = run("--apply", files);
    expect(result.status, result.stderr).toBe(0);

    const hosts = readFileSync(files.hosts, "utf8");
    expect(hosts).not.toContain("papercusp-sni-bypass");
    expect(hosts).not.toMatch(/\b(?:www\.)?papercusp\.com\b/);
    expect(hosts).toContain("192.0.2.8 keep.example");
    expect(hosts).toContain("203.0.113.7 untouched.example");
    expect(readFileSync(files.installedDropin, "utf8")).toBe(
      readFileSync(DROPIN, "utf8"),
    );
    expect(readFileSync(files.installedPolicy, "utf8")).toBe(
      readFileSync(CHROME_POLICY, "utf8"),
    );
  });

  it("is idempotent once the direct-DNS contract is satisfied", async () => {
    const files = fixture();
    expect(run("--apply", files).status).toBe(0);
    const before = {
      hosts: statSync(files.hosts).mtimeMs,
      dropin: statSync(files.installedDropin).mtimeMs,
      policy: statSync(files.installedPolicy).mtimeMs,
    };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(run("--apply", files).status).toBe(0);
    expect(statSync(files.hosts).mtimeMs).toBe(before.hosts);
    expect(statSync(files.installedDropin).mtimeMs).toBe(before.dropin);
    expect(statSync(files.installedPolicy).mtimeMs).toBe(before.policy);

    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/if \(\( changed \)\); then\s+activate_resolver/);
  });

  it("fails check mode when a papercusp hosts override returns", () => {
    const files = fixture();
    expect(run("--apply", files).status).toBe(0);
    writeFileSync(
      files.hosts,
      `${readFileSync(files.hosts, "utf8")}127.0.0.11 papercusp.com\n`,
    );
    expect(run("--check", files).status).not.toBe(0);
  });

  it("pins authenticated DNS and contains no tunnel implementation", () => {
    const dropin = readFileSync(DROPIN, "utf8");
    expect(dropin).toContain("DNSOverTLS=yes");
    expect(dropin).toContain("1.1.1.1#cloudflare-dns.com");
    expect(dropin).toContain("9.9.9.9#dns.quad9.net");

    const chromePolicy = JSON.parse(readFileSync(CHROME_POLICY, "utf8"));
    expect(chromePolicy).toMatchObject({
      BuiltInDnsClientEnabled: true,
      DnsOverHttpsMode: "secure",
      EncryptedClientHelloEnabled: true,
    });
    expect(chromePolicy.DnsOverHttpsTemplates).toContain("cloudflare-dns.com");

    const systemd = ["service", "path", "timer"]
      .map((suffix) =>
        readFileSync(
          join(UNIT_DIR, `papercusp-dns-reconcile.${suffix}`),
          "utf8",
        ),
      )
      .join("\n");
    expect(systemd).not.toMatch(/ssh|vpn|proxy|tunnel/i);
    expect(systemd).toContain("PathChanged=/etc/hosts");
    expect(systemd).toContain("OnUnitActiveSec=5min");
  });
});
