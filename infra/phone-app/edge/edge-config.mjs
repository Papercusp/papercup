// Phone public media edge (plan phone-public-telephone-service-2026-10-01, P-002, D-024/D-025).
//
// The self-hosted LiveKit/SIP media plane runs on a box behind a home router. A small
// cloud VM is its public L4 edge:
//
//   * WireGuard: VM 10.77.0.1 <-> box 10.77.0.2 (the box dials out, so no inbound port
//     is needed at home).
//   * The VM DNATs public media ports to 10.77.0.2 WITHOUT masquerading, so LiveKit sees
//     real client addresses. The box policy-routes everything sourced from 10.77.0.2 back
//     through the tunnel and the VM masquerades it, so replies and STUN leave from the
//     VM's public IP. LiveKit's own STUN discovery therefore maps the tunnel interface to
//     the public IP: no node_ip override and no NAT 1:1 config is needed.
//   * The box must NOT hold the public IP itself: that would make the WireGuard endpoint
//     (the same IP) a local address and the tunnel could never handshake.
//   * TCP/443 is SNI-routed by nginx on the VM: the WSS host is TLS-terminated on the VM and
//     proxied to LiveKit's internal 7890; the TURN host is passed through to LiveKit's own
//     TURN/TLS listener (PHONE_TURN_TLS_PORT, default 7894), which keeps its certificate on
//     the box exactly as infra/phone-app/deploy.sh --hosted already requires.
//
// Pure renderers only. No secret is rendered: WireGuard private keys live in root-only
// files on each host and are loaded by path; the TLS keys never leave the host that
// terminates them.
import { isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';
import { isPublicAddress, publicHostname } from '../media-config.mjs';

export const TUNNEL = Object.freeze({ edge: '10.77.0.1', box: '10.77.0.2', prefix: 30, port: 51820, table: 7792 });
export const VM_TUNNEL_IFACE = 'wg-phone';
const LOCAL_WSS_PORT = 8443;
const IFACE = /^[a-z][a-z0-9-]{0,14}$/;
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/** Ports the VM forwards to the box. SIP/RTP are only forwarded when explicitly enabled
 *  (P-004 opens them at the cloud firewall for the carrier's published source ranges). */
export function forwardedPorts({ sip = false } = {}) {
  const media = [
    { proto: 'udp', ports: '7892', what: 'LiveKit RTC UDP mux' },
    { proto: 'tcp', ports: '7891', what: 'LiveKit RTC TCP fallback' },
    // No TURN/UDP: TURN is TLS-only, reached through the TCP/443 SNI route (WI-10006616).
  ];
  const carrier = [
    { proto: 'udp', ports: '5070', what: 'livekit-sip signalling' },
    { proto: 'tcp', ports: '5070', what: 'livekit-sip signalling' },
    { proto: 'udp', ports: '40000-40200', what: 'livekit-sip RTP' },
  ];
  return sip ? [...media, ...carrier] : media;
}

export function edgeCoordinates(env) {
  const publicIp = String(env.PHONE_EDGE_PUBLIC_IP ?? '');
  if (!isIPv4(publicIp) || !isPublicAddress(publicIp)) {
    throw new Error('PHONE_EDGE_PUBLIC_IP must be a global IPv4 address');
  }
  const voiceHost = publicHostname(String(env.PHONE_EDGE_VOICE_HOST ?? ''));
  const turnHost = publicHostname(String(env.PHONE_EDGE_TURN_HOST ?? ''));
  if (voiceHost === turnHost) throw new Error('WSS and TURN require separate public DNS hostnames');
  const boxIface = env.PHONE_EDGE_IFACE || 'phedge0';
  const wanIface = env.PHONE_EDGE_WAN_IFACE || 'ens4';
  for (const name of [boxIface, wanIface]) {
    if (!IFACE.test(name)) throw new Error('edge interface names must be short lowercase identifiers');
  }
  const turnPort = Number(env.PHONE_TURN_TLS_PORT || '7894');
  if (!Number.isInteger(turnPort) || turnPort < 1024 || turnPort > 65535 ||
      [7890, 7891, 7892, 7893, 5070].includes(turnPort)) {
    throw new Error('TURN TLS backend port must be an unprivileged port distinct from existing media ports');
  }
  return { publicIp, voiceHost, turnHost, boxIface, wanIface, turnPort, sip: env.PHONE_EDGE_FORWARD_SIP === '1' };
}

function wgKey(value, label) {
  if (!WG_KEY.test(String(value ?? ''))) throw new Error(`${label} must be a WireGuard public key`);
  return value;
}

/** wg-quick config for the VM. The private key is loaded from a root-only file. */
export function vmWireguard(c, boxPublicKey) {
  return [
    '# Rendered by infra/phone-app/edge/edge-config.mjs. Phone media edge tunnel (VM side).',
    '[Interface]',
    `Address = ${TUNNEL.edge}/${TUNNEL.prefix}`,
    `ListenPort = ${TUNNEL.port}`,
    `PostUp = wg set %i private-key /etc/wireguard/${VM_TUNNEL_IFACE}.key`,
    '',
    '[Peer]',
    `PublicKey = ${wgKey(boxPublicKey, 'box public key')}`,
    `AllowedIPs = ${TUNNEL.box}/32`,
    '',
  ].join('\n');
}

/** wg-quick config for the box. `Table = off` keeps the home default route; only traffic
 *  SOURCED from the tunnel address is policy-routed through the VM. */
export function boxWireguard(c, vmPublicKey) {
  const rule = `from ${TUNNEL.box} lookup ${TUNNEL.table} priority ${TUNNEL.table}`;
  return [
    '# Rendered by infra/phone-app/edge/edge-config.mjs. Phone media edge tunnel (box side).',
    '[Interface]',
    `Address = ${TUNNEL.box}/${TUNNEL.prefix}`,
    'Table = off',
    `PostUp = wg set %i private-key /etc/wireguard/${c.boxIface}.key`,
    `PostUp = ip rule del ${rule} 2>/dev/null || true`,
    `PostUp = ip rule add ${rule}`,
    `PostUp = ip route replace default dev %i table ${TUNNEL.table}`,
    `PreDown = ip rule del ${rule} 2>/dev/null || true`,
    '',
    '[Peer]',
    `PublicKey = ${wgKey(vmPublicKey, 'edge public key')}`,
    `Endpoint = ${c.publicIp}:${TUNNEL.port}`,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}

/** nftables ruleset for the VM: DNAT without masquerade inbound, masquerade only for flows
 *  the box originates, and a default-drop forward chain limited to the forwarded ports. */
export function vmNftables(c) {
  const wan = c.wanIface;
  const lines = [
    '# Rendered by infra/phone-app/edge/edge-config.mjs. Phone media edge forwarding.',
    'table ip phone_edge',
    'delete table ip phone_edge',
    'table ip phone_edge {',
    '  chain prerouting {',
    '    type nat hook prerouting priority dstnat; policy accept;',
  ];
  for (const p of forwardedPorts(c)) {
    lines.push(`    iifname "${wan}" ${p.proto} dport ${p.ports} dnat to ${TUNNEL.box} comment "${p.what}"`);
  }
  lines.push(
    '  }',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname "${wan}" ip saddr ${TUNNEL.box} masquerade`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter; policy drop;',
    '    ct state established,related accept',
  );
  for (const p of forwardedPorts(c)) {
    lines.push(`    iifname "${wan}" oifname "${VM_TUNNEL_IFACE}" ip daddr ${TUNNEL.box} ${p.proto} dport ${p.ports} accept`);
  }
  lines.push(`    iifname "${VM_TUNNEL_IFACE}" oifname "${wan}" ip saddr ${TUNNEL.box} accept`, '  }', '}', '');
  return lines.join('\n');
}

/** Top-level nginx `stream` block: SNI routing on TCP/443. */
export function nginxStream(c) {
  return [
    '# Rendered by infra/phone-app/edge/edge-config.mjs. Included at the top level of nginx.conf.',
    'stream {',
    '  map $ssl_preread_server_name $phone_edge_backend {',
    `    ${c.turnHost} ${TUNNEL.box}:${c.turnPort};`,
    `    default 127.0.0.1:${LOCAL_WSS_PORT};`,
    '  }',
    '  server {',
    '    listen 443;',
    '    ssl_preread on;',
    '    proxy_pass $phone_edge_backend;',
    '    proxy_connect_timeout 5s;',
    '    proxy_timeout 2h;',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** nginx http site. Before the WSS certificate exists only the ACME/redirect server is
 *  rendered, so nginx can start and certbot's HTTP-01 webroot challenge can succeed. */
export function nginxSite(c, { withTls }) {
  const lines = [
    '# Rendered by infra/phone-app/edge/edge-config.mjs. Phone media edge HTTP site.',
    'map $http_upgrade $phone_edge_connection { default upgrade; "" close; }',
    'server {',
    '  listen 80 default_server;',
    `  server_name ${c.voiceHost} ${c.turnHost};`,
    '  location /.well-known/acme-challenge/ { root /var/www/phone-edge-acme; }',
    '  location / { return 301 https://$host$request_uri; }',
    '}',
  ];
  if (withTls) {
    const live = `/etc/letsencrypt/live/${c.voiceHost}`;
    lines.push(
      'server {',
      `  listen 127.0.0.1:${LOCAL_WSS_PORT} ssl;`,
      `  server_name ${c.voiceHost};`,
      `  ssl_certificate ${live}/fullchain.pem;`,
      `  ssl_certificate_key ${live}/privkey.pem;`,
      '  ssl_protocols TLSv1.2 TLSv1.3;',
      '  location / {',
      `    proxy_pass http://${TUNNEL.box}:7890;`,
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection $phone_edge_connection;',
      '    proxy_set_header Host $host;',
      '    proxy_read_timeout 2h;',
      '    proxy_send_timeout 2h;',
      '  }',
      '}',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** LiveKit `interfaces.includes` entry for the box tunnel, spliced into
 *  infra/phone-app/livekit-server.yaml.tmpl as ${PHONE_EDGE_IFACE_INCLUDE}. */
export function livekitInterfaceInclude(env) {
  const iface = env.PHONE_EDGE_IFACE;
  if (!iface) return '      # no public media edge tunnel configured';
  if (!IFACE.test(iface)) throw new Error('PHONE_EDGE_IFACE must be a short lowercase interface name');
  return `      - ${iface}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    const arg = process.argv[3];
    const c = action === 'livekit-interface-include' ? null : edgeCoordinates(process.env);
    let out;
    if (action === 'coordinates') out = JSON.stringify(c);
    else if (action === 'vm-wireguard') out = vmWireguard(c, arg);
    else if (action === 'box-wireguard') out = boxWireguard(c, arg);
    else if (action === 'vm-nftables') out = vmNftables(c);
    else if (action === 'nginx-stream') out = nginxStream(c);
    else if (action === 'nginx-site-bootstrap') out = nginxSite(c, { withTls: false });
    else if (action === 'nginx-site') out = nginxSite(c, { withTls: true });
    else if (action === 'livekit-interface-include') out = livekitInterfaceInclude(process.env);
    else throw new Error(`unknown action: ${action ?? '(none)'}`);
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
