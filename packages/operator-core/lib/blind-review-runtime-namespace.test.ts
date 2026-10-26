import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brokerSourceFixture } from './blind-review-source.fixture';
import { packRuntimeSourceImage } from './blind-review-source-image';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));

describe('native services in the sealed runtime namespace', () => {
  it('boots an actual private PostgreSQL using guest NSS without mounting host identity or configuration', async () => {
    const f = await brokerSourceFixture(roots), image = await packRuntimeSourceImage(f);
    const hostMachineId = readFileSync('/etc/machine-id', 'utf8').trim();
    try {
      rmSync(f.root, { recursive: true }); rmSync(f.repositoryRoot, { recursive: true });
      const run = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', `
import ipaddress,json,os,pwd,socket,stat,subprocess,time
assert pwd.getpwuid(os.getuid()).pw_name == 'review'
assert pwd.getpwuid(os.getuid()).pw_dir == '/tmp/home'
assert os.environ['HOME'] == '/tmp/home'
assert os.environ['XDG_RUNTIME_DIR'] == '/tmp/run'
assert os.environ.get('BROKER_HOST_SECRET') is None
assert open('/etc/machine-id').read().strip() != ${JSON.stringify(hostMachineId)}
assert open('/etc/resolv.conf').read() == ''
assert socket.gethostbyname('localhost') == '127.0.0.1'
assert socket.gethostname() == 'review-runtime'
assert not os.path.exists(${JSON.stringify(f.custodyRoot)})
assert stat.S_ISCHR(os.stat('/dev/null').st_mode)
with open('/dev/null','r+b',buffering=0) as device:
 assert device.write(b'private_device_preflight') == 24
 assert device.read(1) == b''
with open('/dev/urandom','rb',buffering=0) as device:
 assert len(device.read(16)) == 16
assert os.path.isdir('/dev/shm'), 'private_shm_missing'
assert stat.S_IMODE(os.stat('/tmp/run').st_mode) == 0o700
try:
 open('/etc/passwd','a').write('foreign')
except OSError: pass
else: raise AssertionError('guest identity is writable')
env={'PATH':'/usr/bin:/bin','HOME':'/tmp/home','LANG':'C.UTF-8'}
bin='/usr/lib/postgresql/18/bin/'
init=subprocess.run([bin+'initdb','-D','/tmp/pg','-U','review','-A','trust','--locale=C','--no-sync'],
 env=env,capture_output=True,text=True,timeout=15)
assert init.returncode == 0, init.stderr
server=subprocess.Popen([bin+'postgres','-D','/tmp/pg','-p','5432',
 '-c','listen_addresses=127.0.0.1','-c','unix_socket_directories=','-c','logging_collector=off'],
 env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 deadline=time.monotonic()+15
 while True:
  assert server.poll() is None, 'private_postmaster_exited'
  try:
   connection=socket.create_connection(('127.0.0.1',5432),timeout=.2); connection.close(); break
  except OSError:
   assert time.monotonic()<deadline, 'private_postmaster_not_ready'
   time.sleep(.05)
 query=subprocess.run([bin+'psql','-h','127.0.0.1','-p','5432','-U','review','-d','postgres','-At','-c',
  "select current_user || ':' || (inet_server_addr()::text)"],env=env,capture_output=True,text=True,timeout=5)
 assert query.returncode == 0, query.stderr
 user,address=query.stdout.strip().split(':',1)
 assert user == 'review', repr(query.stdout)
 assert str(ipaddress.ip_interface(address).ip) == '127.0.0.1', repr(query.stdout)
finally:
 server.terminate(); server.wait(timeout=10)
print(json.dumps({'marker':'PRIVATE_NATIVE_PG_NAMESPACE_VERIFIED','user':user,
 'serverAddress':str(ipaddress.ip_interface(address).ip),'rawAddress':address}))`], {
        stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 45_000,
        env: { PATH: '/usr/bin:/bin', BROKER_HOST_SECRET: 'HOST_CONFIG_CANARY' },
      });
      expect(run.error).toBeUndefined(); expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toMatchObject({ marker: 'PRIVATE_NATIVE_PG_NAMESPACE_VERIFIED',
        user: 'review', serverAddress: '127.0.0.1' });
      console.log('NATIVE_PG_NAMESPACE_OBSERVATION ' + run.stdout.trim());
    } finally { await image.handle.close(); }
  }, 60_000);
});
