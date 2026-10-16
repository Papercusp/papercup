/** E2E: real OpenSSH between the test client and an isolated private-network computer.
 * The remote psu/HTTP fixtures observe transport behavior; this is not release GUI proof. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  defaultPsuConnectionStorePath, normalizeSshProfile, PSU_CONNECTION_STORE_VERSION,
  runPsuConnectionFrontController, savePsuConnectionStore,
} from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';

let root = '';
let container = '';
let config = '';
const masters = new Set<string>();
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000 });

async function ssh(command: string, args: string[]) {
  expect(command).toBe('ssh');
  const socket = args.indexOf('-S');
  if (socket >= 0) masters.add(args[socket + 1]);
  return new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    const child = spawn(command, ['-F', config, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 20_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pc-personal-ssh-'));
  for (const name of ['client', 'host']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)], { timeout: 10_000 });
  }
  writeFileSync(join(root, 'psu'), `#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps({'argv':sys.argv[1:],'forwarded':os.environ.get('PAPERCUSP_PSU_CONNECTION_FORWARDED'),'cwd':os.getcwd()}),flush=True)\n`);
  writeFileSync(join(root, 'gui.py'), `from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'personal-computer-gui')\nHTTPServer(('127.0.0.1',3070),H).serve_forever()\n`);
  container = `pc-personal-ssh-${randomUUID()}`;
  docker(['run', '--detach', '--rm', '--name', container, '-p', '127.0.0.1::22',
    '--mount', `type=bind,source=${root},target=/fixture,readonly`, 'debian:stable-slim', 'sh', '-ec',
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server tmux python3 >/dev/null; '
    + 'mkdir -p /run/sshd /root/.ssh; cp /fixture/client.pub /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; '
    + 'cp /fixture/host /etc/ssh/ssh_host_ed25519_key; chmod 600 /etc/ssh/ssh_host_ed25519_key; '
    + 'cp /fixture/psu /usr/local/bin/psu; chmod 755 /usr/local/bin/psu; '
    + 'python3 /fixture/gui.py >/tmp/gui.log 2>&1 & exec /usr/sbin/sshd -D -e -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no']);
  const address = docker(['port', container, '22/tcp']).trim();
  expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
  const port = address.split(':').at(-1)!;
  // Pin the independently generated fixture host key, never trust ssh-keyscan.
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${readFileSync(join(root, 'host.pub'), 'utf8')}`);
  config = join(root, 'ssh_config');
  writeFileSync(config, `Host personal-fixture\n HostName 127.0.0.1\n Port ${port}\n User root\n IdentityFile ${root}/client\n IdentitiesOnly yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${root}/known_hosts\n GlobalKnownHostsFile /dev/null\n`);
  let ready = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await ssh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1', 'personal-fixture', 'true']);
    if (result.code === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  expect(ready, 'isolated sshd did not become ready; inspect the named test container logs').toBe(true);
}, 200_000);

afterAll(() => {
  if (config) for (const socket of masters) {
    try { execFileSync('ssh', ['-F', config, '-S', socket, '-O', 'exit', '--', 'personal-fixture'], { stdio: 'ignore', timeout: 5_000 }); } catch { /* already gone */ }
  }
  if (container) { try { docker(['rm', '--force', container]); } catch { /* already removed */ } }
  if (root) rmSync(root, { recursive: true, force: true });
});

test('runs remote psu, serves the private GUI and refuses a revoked or offline computer', async () => {
  savePsuConnectionStore({ version: PSU_CONNECTION_STORE_VERSION,
    profiles: [normalizeSshProfile({ name: 'desktop', host: 'personal-fixture' })],
  }, defaultPsuConnectionStorePath(root));
  let terminalOutput = '';
  const deps = {
    home: root, interactive: true, commandAvailable: () => true, notice: () => {},
    runCommand: ssh,
    runInteractive: async (command: string, args: string[]) => {
      const result = await ssh(command, args); terminalOutput += result.output; return result;
    },
  };
  const terminal = await runPsuConnectionFrontController(['--connect=desktop', '--resume=session 1', '--label=quoted value'], deps);
  expect(terminal.exitCode).toBe(0);
  expect(terminalOutput).toContain('"argv": ["--resume=session 1", "--label=quoted value"]');
  expect(terminalOutput).toContain('"forwarded": "1"');
  expect(terminalOutput).toContain('"cwd": "/root"');

  let browserUrl = '';
  const browser = { ...deps, openBrowser: (url: string) => { browserUrl = url; },
    waitForGuiClose: async () => {
      expect(new URL(browserUrl).hostname).toBe('127.0.0.1');
      expect(await (await fetch(browserUrl)).text()).toBe('personal-computer-gui');
    },
  };
  expect((await runPsuConnectionFrontController(['--connect=desktop', '--connect-gui'], browser)).exitCode).toBe(0);
  await expect(fetch(browserUrl)).rejects.toThrow();

  // Revocation includes closing existing SSH connections, not just deleting a key.
  docker(['exec', container, 'sh', '-c', ': > /root/.ssh/authorized_keys']);
  for (const socket of masters) await ssh('ssh', ['-S', socket, '-O', 'exit', '--', 'personal-fixture']);
  browserUrl = '';
  await expect(runPsuConnectionFrontController(['--connect=desktop', '--connect-gui'], browser)).rejects.toThrow(/OpenSSH host-key and authentication policy/);
  expect(browserUrl).toBe('');
  docker(['stop', container]);
  await expect(runPsuConnectionFrontController(['--connect=desktop'], deps)).rejects.toThrow(/OpenSSH host-key and authentication policy/);
}, 90_000);
