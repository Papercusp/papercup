import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TUNNEL, boxWireguard, edgeCoordinates, forwardedPorts, livekitInterfaceInclude,
  nginxSite, nginxStream, vmNftables, vmWireguard,
} from "../../../../infra/phone-app/edge/edge-config.mjs";

// Plan phone-public-telephone-service-2026-10-01, P-002, D-024/D-025: the public media edge.
const repoRoot = resolve(import.meta.dirname, "../../../..");
const edgeScript = resolve(repoRoot, "infra/phone-app/edge/edge.sh");
const template = resolve(repoRoot, "infra/phone-app/livekit-server.yaml.tmpl");
const deployScript = resolve(repoRoot, "infra/phone-app/deploy.sh");

const env = {
  PHONE_EDGE_PUBLIC_IP: "34.23.13.209",
  PHONE_EDGE_VOICE_HOST: "phone-voice.papercusp.com",
  PHONE_EDGE_TURN_HOST: "phone-turn.papercusp.com",
};
const KEY_A = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const KEY_B = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

describe("phone public media edge coordinates", () => {
  it("accepts a global IPv4 address with two distinct public hostnames", () => {
    expect(edgeCoordinates(env)).toEqual({
      publicIp: "34.23.13.209", voiceHost: "phone-voice.papercusp.com", turnHost: "phone-turn.papercusp.com",
      boxIface: "phedge0", wanIface: "ens4", turnPort: 7894, sip: false,
    });
  });

  it.each(["10.0.0.1", "192.168.4.34", "127.0.0.1", "100.74.143.93", "2001:db8::1", "", "not-an-ip"])(
    "rejects a non-global edge address %j",
    (address) => {
      expect(() => edgeCoordinates({ ...env, PHONE_EDGE_PUBLIC_IP: address })).toThrow(/global IPv4/);
    },
  );

  it("refuses a shared WSS/TURN hostname, a hostile interface name and a colliding TURN port", () => {
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_TURN_HOST: env.PHONE_EDGE_VOICE_HOST })).toThrow(/separate/);
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_IFACE: "wg0; rm -rf /" })).toThrow(/interface/);
    expect(() => edgeCoordinates({ ...env, PHONE_TURN_TLS_PORT: "7892" })).toThrow(/TURN TLS backend port/);
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_VOICE_HOST: "voice.internal" })).toThrow();
  });
});

describe("phone public media edge tunnel", () => {
  const c = edgeCoordinates(env);

  it("never makes the edge's public IP a box-local address (the WireGuard endpoint would loop back)", () => {
    const box = boxWireguard(c, KEY_A);
    const address = box.split("\n").find((line) => line.startsWith("Address"));
    expect(address).toBe(`Address = ${TUNNEL.box}/${TUNNEL.prefix}`);
    expect(box).toContain(`Endpoint = ${c.publicIp}:${TUNNEL.port}`);
  });

  it("routes only traffic sourced from the tunnel address through the edge, not the box's default route", () => {
    const box = boxWireguard(c, KEY_A);
    expect(box).toContain("Table = off");
    expect(box).toContain(`ip rule add from ${TUNNEL.box} lookup ${TUNNEL.table}`);
    expect(box).toContain(`ip route replace default dev %i table ${TUNNEL.table}`);
    expect(box).toContain("AllowedIPs = 0.0.0.0/0");
  });

  it("loads WireGuard private keys by path and rejects anything that is not a public key", () => {
    for (const conf of [boxWireguard(c, KEY_A), vmWireguard(c, KEY_B)]) {
      expect(conf).not.toMatch(/PrivateKey\s*=/);
      expect(conf).toMatch(/private-key \/etc\/wireguard\/[a-z0-9-]+\.key/);
    }
    expect(vmWireguard(c, KEY_B)).toContain(`AllowedIPs = ${TUNNEL.box}/32`);
    expect(() => vmWireguard(c, "not a key")).toThrow(/public key/);
    expect(() => boxWireguard(c, `${KEY_A}\nPostUp = curl evil`)).toThrow(/public key/);
  });
});

describe("phone public media edge forwarding", () => {
  const c = edgeCoordinates(env);

  it("DNATs media ports to the box without masquerading inbound, so clients keep their real addresses", () => {
    const rules = vmNftables(c);
    for (const { proto, ports } of forwardedPorts()) {
      expect(rules).toContain(`iifname "ens4" ${proto} dport ${ports} dnat to ${TUNNEL.box}`);
    }
    const masquerades = rules.split("\n").filter((line) => line.includes("masquerade"));
    expect(masquerades).toEqual([`    oifname "ens4" ip saddr ${TUNNEL.box} masquerade`]);
    expect(rules).toContain("type filter hook forward priority filter; policy drop;");
  });

  it("keeps SIP and RTP closed until they are explicitly enabled for the carrier", () => {
    expect(vmNftables(c)).not.toMatch(/dport (5070|40000-40200)/);
    const withSip = vmNftables(edgeCoordinates({ ...env, PHONE_EDGE_FORWARD_SIP: "1" }));
    expect(withSip).toContain(`udp dport 40000-40200 dnat to ${TUNNEL.box}`);
    expect(withSip).toContain(`tcp dport 5070 dnat to ${TUNNEL.box}`);
  });
});

describe("phone public media edge TLS front end", () => {
  const c = edgeCoordinates(env);

  it("passes TURN/TLS through to LiveKit by SNI and terminates WSS locally", () => {
    const stream = nginxStream(c);
    expect(stream).toContain("ssl_preread on;");
    expect(stream).toContain(`phone-turn.papercusp.com ${TUNNEL.box}:7894;`);
    expect(stream).toContain("default 127.0.0.1:8443;");
    expect(stream).toContain("listen 443;");
  });

  it("serves only ACME and redirects before the WSS certificate exists", () => {
    const bootstrap = nginxSite(c, { withTls: false });
    expect(bootstrap).toContain("location /.well-known/acme-challenge/ { root /var/www/phone-edge-acme; }");
    expect(bootstrap).not.toContain("ssl_certificate");
  });

  it("proxies the WSS host to LiveKit's internal port with WebSocket upgrade once certified", () => {
    const site = nginxSite(c, { withTls: true });
    expect(site).toContain("ssl_certificate /etc/letsencrypt/live/phone-voice.papercusp.com/fullchain.pem;");
    expect(site).toContain(`proxy_pass http://${TUNNEL.box}:7890;`);
    expect(site).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(site).toContain("listen 127.0.0.1:8443 ssl;");
  });
});

describe("LiveKit picks up the edge tunnel interface", () => {
  function renderIncludes(envOverride: Record<string, string>) {
    const include = livekitInterfaceInclude(envOverride);
    const rendered = readFileSync(template, "utf8")
      .replace("${PHONE_LAN_IFACE}", "wlp183s0")
      .replace("${PHONE_EDGE_IFACE_INCLUDE}", include);
    const lines = rendered.split("\n");
    const start = lines.indexOf("    includes:");
    expect(start).toBeGreaterThan(0);
    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("      ")) break;
      if (line.trimStart().startsWith("- ")) items.push(line.trim().slice(2));
    }
    return items;
  }

  it("adds the tunnel to interfaces.includes when configured and nothing otherwise", () => {
    expect(renderIncludes({ PHONE_EDGE_IFACE: "phedge0" })).toEqual(["lo", "wlp183s0", "phedge0"]);
    expect(renderIncludes({})).toEqual(["lo", "wlp183s0"]);
    expect(() => livekitInterfaceInclude({ PHONE_EDGE_IFACE: "x\n  use_external_ip: false" })).toThrow();
  });

  it("is rendered and persisted by the existing deployer", () => {
    const deploy = readFileSync(deployScript, "utf8");
    expect(deploy).toMatch(/MEDIA_KEYS=\([^)]*PHONE_EDGE_IFACE[^)]*\)/);
    expect(deploy).toContain("content=\"${content//'${PHONE_EDGE_IFACE_INCLUDE}'/$PHONE_EDGE_IFACE_INCLUDE}\"");
    expect(deploy).toContain("edge/edge-config.mjs\" livekit-interface-include");
  });

  it("keeps the edge driver syntactically valid", () => {
    const result = spawnSync("bash", ["-n", edgeScript], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

// WI-10006571: `deploy.sh --rotate-secret` used to truncate livekit.env to the two
// LiveKit lines, deleting the worker's DEEPGRAM_API_KEY (STT then resolved to a
// fallback vendor and the worker refused to start) and any TELNYX_API_KEY (D-020).
// PROBE_DEPLOY_SCRIPT lets scripts/mutation-probe.sh point these at a mutated copy.
const probedDeployScript = process.env.PROBE_DEPLOY_SCRIPT ?? deployScript;

/** The named top-level shell functions of deploy.sh, verbatim, so tests run the real code. */
function extractShellFunctions(script: string, names: string[]): string {
  const lines = readFileSync(script, "utf8").split("\n");
  const out: string[] = [];
  for (const name of names) {
    const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
    expect(start, `${name}() must be defined in deploy.sh`).toBeGreaterThanOrEqual(0);
    if (lines[start].trimEnd().endsWith("}")) { out.push(lines[start]); continue; }
    const end = lines.findIndex((line, i) => i > start && line === "}");
    expect(end).toBeGreaterThan(start);
    out.push(...lines.slice(start, end + 1));
  }
  return out.join("\n");
}

describe("rotating the LiveKit secret keeps the rest of livekit.env", () => {
  const script = probedDeployScript;
  const shellFunctions = () => extractShellFunctions(script, ["die", "upsert_env_var", "write_livekit_credentials"]);

  function rotate(existing: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "phone-env-"));
    const envFile = join(dir, "livekit.env");
    if (existing !== null) writeFileSync(envFile, existing, { mode: 0o600 });
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${shellFunctions()}\nwrite_livekit_credentials NEWKEY NEWSECRET`], {
      encoding: "utf8",
      env: { ...process.env, CONF_DIR: dir, ENV_FILE: envFile },
    });
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(envFile, "utf8");
    const mode = statSync(envFile).mode & 0o777;
    rmSync(dir, { recursive: true, force: true });
    return { content, mode };
  }

  it("replaces only the key pair and preserves every other credential", () => {
    const { content, mode } = rotate([
      "PHONE_LIVEKIT_API_KEY=OLDKEY",
      "PHONE_LIVEKIT_API_SECRET=OLDSECRET",
      "DEEPGRAM_API_KEY=dg-test",
      "GOOGLE_CLOUD_PROJECT=proj-test",
      "TELNYX_API_KEY=KEYtest",
      "PHONE_EDGE_IFACE=phedge0",
      "",
    ].join("\n"));
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toEqual(expect.arrayContaining([
      "DEEPGRAM_API_KEY=dg-test",
      "GOOGLE_CLOUD_PROJECT=proj-test",
      "TELNYX_API_KEY=KEYtest",
      "PHONE_EDGE_IFACE=phedge0",
      "PHONE_LIVEKIT_API_KEY=NEWKEY",
      "PHONE_LIVEKIT_API_SECRET=NEWSECRET",
    ]));
    expect(lines).toHaveLength(6);
    expect(content).not.toContain("OLD");
    expect(mode).toBe(0o600);
  });

  it("creates a private file holding just the key pair on first run", () => {
    const { content, mode } = rotate(null);
    expect(content.split("\n").filter(Boolean).sort()).toEqual([
      "PHONE_LIVEKIT_API_KEY=NEWKEY",
      "PHONE_LIVEKIT_API_SECRET=NEWSECRET",
    ]);
    expect(mode).toBe(0o600);
  });

  it("is the only path the credentials step uses to write the key pair", () => {
    const deploy = readFileSync(script, "utf8");
    expect(deploy).toContain('write_livekit_credentials "$KEY" "$SECRET"');
    const truncating = deploy.split("\n").filter((line) => /[^>]>\s*"\$ENV_FILE"/.test(line));
    expect(truncating.every((line) => line.includes('[[ -f "$ENV_FILE" ]] ||'))).toBe(true);
  });

  it("keeps the deployer syntactically valid", () => {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

// Both 2026-10-06 hosted redeploys exited 1 because one readiness read straight
// after the restart caught the sidecar's HTTP endpoint a few seconds early.
describe("the deployer waits for readiness to converge after a restart", () => {
  function awaitReadiness(readyOnCall: number | null, attempts: number) {
    const dir = mkdtempSync(join(tmpdir(), "phone-ready-"));
    const counter = join(dir, "calls");
    writeFileSync(counter, "0");
    const stub = [
      "report_status() {",
      `  local n=$(( $(cat '${counter}') + 1 )); echo "$n" > '${counter}'`,
      readyOnCall === null
        ? '  echo "NOT_READY $n"; return 1'
        : `  if (( n >= ${readyOnCall} )); then echo "READY $n"; else echo "NOT_READY $n"; return 1; fi`,
      "}",
    ].join("\n");
    const fn = extractShellFunctions(probedDeployScript, ["await_readiness"]);
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${stub}\n${fn}\nawait_readiness ${attempts}`], {
      encoding: "utf8",
      env: { ...process.env, PHONE_READINESS_RETRY_SEC: "0" },
    });
    const calls = Number(readFileSync(counter, "utf8").trim());
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, stdout: result.stdout, calls };
  }

  it("succeeds once a transiently unready component converges, printing one report", () => {
    const { status, stdout, calls } = awaitReadiness(3, 30);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("READY 4");
    expect(calls).toBe(4);
  });

  it("still fails closed, within its bound, when a component never converges", () => {
    const { status, stdout, calls } = awaitReadiness(null, 5);
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe("NOT_READY 5");
    expect(calls).toBe(5);
  });

  it("is what the deployer runs as its final health step", () => {
    const deploy = readFileSync(probedDeployScript, "utf8");
    const finalStep = deploy.slice(deploy.lastIndexOf('step "Health"'));
    expect(finalStep).toMatch(/\nawait_readiness \d+\n/);
    expect(finalStep).not.toMatch(/\nreport_status\n/);
  });
});

// WI-10006603: the public TURN server must not relay to private or loopback peers.
// livekit-server gained that default in v1.12.0 and the per-participant relay cap
// in v1.13.6; the 1.10.1 build that was deployed relayed anywhere, livekit-sip included.
describe("the deployer refuses a livekit-server whose TURN relays to private peers", () => {
  const floor = () => /^LK_MIN_VERSION="([^"]+)"$/m.exec(readFileSync(probedDeployScript, "utf8"))?.[1];

  function requireVersion(reported: string) {
    const dir = mkdtempSync(join(tmpdir(), "phone-lkver-"));
    const bin = join(dir, "livekit-server");
    writeFileSync(bin, `#!/usr/bin/env bash\necho 'livekit-server version ${reported}'\n`, { mode: 0o755 });
    const fns = extractShellFunctions(probedDeployScript, ["say", "die", "require_livekit_version"]);
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${fns}\nrequire_livekit_version '${bin}' '${floor()}'`], {
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("refuses the 1.10.1 build that was deployed, and every version below the floor", () => {
    for (const old of ["1.10.1", "1.12.0", "1.13.5", "0.99.99"]) {
      const { status, out } = requireVersion(old);
      expect(status, old).not.toBe(0);
      expect(out, old).toContain("WI-10006603");
    }
  });

  it("accepts the floor and newer, comparing versions numerically rather than as text", () => {
    for (const ok of ["1.13.6", "1.13.7", "1.13.10", "2.0.0"]) {
      const { status, out } = requireVersion(ok);
      expect(status, ok).toBe(0);
      expect(out).toContain(`livekit-server ${ok}`);
    }
  });

  it("refuses when the version cannot be read", () => {
    const { status, out } = requireVersion("dev");
    expect(status).not.toBe(0);
    expect(out).toContain("cannot read a livekit-server version");
  });

  it("is the preflight check, at a floor that has both TURN protections", () => {
    const [major, minor, patch] = (floor() ?? "0.0.0").split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_013_006);
    expect(readFileSync(probedDeployScript, "utf8")).toMatch(/\nrequire_livekit_version "\$LK_BIN" "\$LK_MIN_VERSION"\n/);
  });
});

describe("the public TURN server keeps private and loopback peers unreachable", () => {
  const live = (file: string) =>
    readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  it("never opts a restricted range back in, in the template or in what the deployer renders into it", () => {
    for (const file of [template, probedDeployScript]) {
      expect(live(file), file).not.toMatch(/allow_restricted_peer_cidrs/);
    }
  });

  it("caps relay allocations per participant", () => {
    const limit = /^\s+per_user_relay_allocation_limit:\s*(\d+)\s*$/m.exec(live(template))?.[1];
    expect(Number(limit)).toBeGreaterThan(0);
  });
});

describe("public clients are only offered TURN they can reach (WI-10006616)", () => {
  const live = (file: string) =>
    readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const turnBlock = () => /^turn:\n((?:[ \t]+.*\n|\n)*)/m.exec(live(template))?.[1] ?? "";

  it("keeps TURN TLS-only, so no turn:<home IP>:<udp port> URL is issued", () => {
    expect(turnBlock()).toMatch(/^\s+enabled:\s*true\s*$/m);
    expect(turnBlock()).not.toMatch(/udp_port/);
  });

  it("neither the edge nor its firewall forwards a TURN/UDP port", () => {
    expect(forwardedPorts().filter(({ proto, ports }) => proto === "udp" && ports !== "7892")).toEqual([]);
    expect(forwardedPorts({ sip: true }).some(({ ports }) => ports === "7893")).toBe(false);
    const edgeScript = live(resolve(repoRoot, "infra/phone-app/edge/edge.sh"));
    expect(edgeScript).not.toMatch(/udp:7893/);
    expect(edgeScript).not.toMatch(/ufw allow in on [^\n]*port [0-9,]*7893/);
  });
});
