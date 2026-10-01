// Shared by the existing deployer and its registered tests. No credentials are logged.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:tls';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001:2::', 48, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); // IETF special assignments, including embedded-address tunnels
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4 can embed a non-public IPv4 address

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicHostname(hostname) {
  if (!hostname || hostname.length > 253 || isIP(hostname) ||
      !hostname.includes('.') || !hostname.split('.').every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/i.test(hostname)) {
    throw new Error('public media requires a public DNS hostname');
  }
  return hostname.toLowerCase();
}

export function publicMediaUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('invalid public media URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid public media URL'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || (url.port && url.port !== '443')) {
    throw new Error('public media requires a wss:// origin on port 443 without credentials, path or query');
  }
  publicHostname(url.hostname);
  return url;
}

export function validateCertificate(certPem, keyPem, hostname, now = Date.now()) {
  const cert = new X509Certificate(certPem);
  if (!cert.checkHost(hostname) || Date.parse(cert.validFrom) > now ||
      Date.parse(cert.validTo) < now + 7 * 86400_000) {
    throw new Error('TURN certificate must cover its hostname and remain valid for at least seven days');
  }
  const actual = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  const expected = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (!actual.equals(expected)) throw new Error('TURN certificate and private key do not match');
  return cert;
}

export function mediaConfig(env, hosted = false) {
  const publicUrl = env.PHONE_LIVEKIT_PUBLIC_URL;
  if (publicUrl) publicMediaUrl(publicUrl);
  else if (hosted) throw new Error('hosted deployment requires PHONE_LIVEKIT_PUBLIC_URL=wss://...');
  const domain = env.PHONE_TURN_DOMAIN;
  const certPath = env.PHONE_TURN_CERT_FILE;
  const keyPath = env.PHONE_TURN_KEY_FILE;
  if (!domain && !certPath && !keyPath && !env.PHONE_TURN_TLS_PORT && !hosted) {
    return { turnYaml: '  tls_port: 0', publicUrl };
  }
  const hostname = publicHostname(domain);
  if (!certPath?.startsWith('/') || !keyPath?.startsWith('/') ||
      /[\r\n\0]/.test(certPath + keyPath)) {
    throw new Error('TURN certificate and key require absolute external file paths');
  }
  if (!publicUrl) throw new Error('TURN/TLS requires the public WSS origin');
  if (new URL(publicUrl).hostname === hostname) {
    throw new Error('WSS and TURN require separate public DNS hostnames');
  }
  const port = Number(env.PHONE_TURN_TLS_PORT || '7894');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [7890, 7891, 7892, 7893, 5070].includes(port)) {
    throw new Error('TURN TLS backend port must be an unprivileged port distinct from existing media ports');
  }
  validateCertificate(readFileSync(certPath), readFileSync(keyPath), hostname);
  return {
    publicUrl, turnDomain: hostname, turnPort: port,
    turnYaml: ['  tls_port: ' + port, '  domain: ' + JSON.stringify(hostname),
      '  cert_file: ' + JSON.stringify(certPath), '  key_file: ' + JSON.stringify(keyPath)].join('\n'),
  };
}

export async function publicAddresses(hostname, resolve = lookup) {
  publicHostname(hostname);
  const rows = await resolve(hostname, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) {
    throw new Error('public media DNS must resolve exclusively to global addresses');
  }
  return [...new Set(rows.map(row => row.address))];
}

// Connecting to the measured address pins DNS; SNI and CA verification still use
// the original hostname. ca is a test seam; the CLI always uses system trust.
export function checkTlsEndpoint({ hostname, address, port = 443, timeoutMs = 5000, ca }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, servername: hostname,
      rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => finish(new Error('public media TLS connection timed out')), timeoutMs);
    let done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    }
    socket.once('error', () => finish(new Error('public media TLS trust or connectivity check failed')));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!socket.authorized || Date.parse(cert.valid_to) < Date.now() + 7 * 86400_000) {
        finish(new Error('public media TLS certificate is untrusted or renewal is due'));
      } else finish(null, { hostname, address, validTo: cert.valid_to });
    });
  });
}

export async function remotePreflight(env) {
  // A remote client needs only these two non-secret coordinates. It never
  // needs the media API credential, TURN private key or server filesystem.
  const url = publicMediaUrl(env.PHONE_LIVEKIT_PUBLIC_URL);
  const turnDomain = publicHostname(env.PHONE_TURN_DOMAIN);
  if (url.hostname === turnDomain) throw new Error('WSS and TURN require separate public DNS hostnames');
  const reports = [];
  for (const hostname of [url.hostname, turnDomain]) {
    for (const address of await publicAddresses(hostname)) {
      reports.push(await checkTlsEndpoint({ hostname, address }));
    }
  }
  return { checks: reports, audioVerified: false,
    next: 'Prove authenticated bidirectional audio from external and UDP-blocked clients; TLS is a prerequisite only.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    if (action === 'preflight') console.log(JSON.stringify(await remotePreflight(process.env)));
    else if (action === 'public-dns') {
      const config = mediaConfig(process.env, true);
      for (const hostname of [new URL(config.publicUrl).hostname, config.turnDomain]) {
        await publicAddresses(hostname);
      }
      console.log('public media DNS prerequisites passed');
    }
    else if (action === 'turn-config') console.log(mediaConfig(process.env, process.argv.includes('--hosted')).turnYaml);
    else throw new Error('expected turn-config, public-dns or preflight');
  } catch (error) {
    // Crypto/file exceptions can include input details. Report their class only.
    const safe = error.code ? 'media prerequisite failed (' + error.code + ')' :
      error.message.startsWith('error:') ? 'media certificate validation failed' : error.message;
    console.error(safe);
    process.exitCode = 1;
  }
}
