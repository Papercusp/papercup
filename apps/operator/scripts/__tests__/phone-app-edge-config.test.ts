import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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
