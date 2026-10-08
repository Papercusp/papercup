/** Synthetic identity transport for the isolated native Workbench suite only. */
import childProcess from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

export function prepareIdentityFixture(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pair = () => {
    const key = generateKeyPairSync('ed25519');
    return { publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
      privateKeyDer: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  };
  const fixture = { kind: 'dao-workbench-synthetic-identity-v1', githubUserId: 90007527,
    githubLogin: 'native-workbench-member', keychainId: 'dao-native-fixture-device', device: pair(), hive: pair() };
  const path = join(directory, 'identity.json');
  writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
  writeFileSync(join(directory, 'announce.json'), JSON.stringify({ version: 1, savedAt: Date.now(),
    githubUserId: fixture.githubUserId, githubLogin: fixture.githubLogin, keychainId: fixture.keychainId,
    devicePubkeyBase64: fixture.device.publicKey, attestationGistId: 'synthetic-native-gist' }), { mode: 0o600 });
  return path;
}

export function installIdentityFixture(fixture, env = process.env) {
  if (env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' || fixture.kind !== 'dao-workbench-synthetic-identity-v1')
    throw new Error('Synthetic Workbench identity requires explicit isolated native verification');
  const originalExec = childProcess.execFile;
  const originalFetch = globalThis.fetch;
  const priorToken = globalThis.__ghAuthToken;
  const token = 'synthetic-workbench-token';
  globalThis.__ghAuthToken = { token, fetchedAt: Date.now(), githubLogin: env.PAPERCUSP_GITHUB_LOGIN || null };
  const intercepted = (file, args) => {
    if (file === 'gh') {
      if (args[0] === 'auth' && args[1] === 'token') return { stdout: token + '\n', stderr: '' };
      throw new Error('Synthetic fixture refuses other GitHub CLI commands');
    }
    if (file !== 'secret-tool' && file !== 'security') return null;
    if (file !== 'secret-tool' || args[0] !== 'lookup') throw new Error('Synthetic fixture refuses OS keychain writes');
    const account = args[args.indexOf('account') + 1];
    const service = args[args.indexOf('service') + 1];
    if (account === fixture.keychainId && service === 'papercusp-device-keypair')
      return { stdout: fixture.device.privateKeyDer, stderr: '' };
    if (/^hive:verify-tauri-isolated-\d+:workbench-native$/.test(account) && service === 'papercusp-hive-keypair')
      return { stdout: fixture.hive.privateKeyDer, stderr: '' };
    throw new Error('Synthetic fixture refuses unknown keychain identity');
  };
  const replacement = function(file, args = [], ...rest) {
    if (!['gh', 'secret-tool', 'security'].includes(file)) return originalExec.call(this, file, args, ...rest);
    const callback = rest.findLast(value => typeof value === 'function');
    queueMicrotask(() => {
      try { const result = intercepted(file, args); callback?.(null, result.stdout, result.stderr); }
      catch (error) { callback?.(error, '', ''); }
    });
    return new EventEmitter();
  };
  replacement[promisify.custom] = async (file, args = [], ...rest) => {
    if (!['gh', 'secret-tool', 'security'].includes(file)) return promisify(originalExec)(file, args, ...rest);
    return intercepted(file, args);
  };
  childProcess.execFile = replacement;
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.github.com') return originalFetch(input, init);
    if (url.pathname !== '/user' || (init?.method || 'GET') !== 'GET')
      throw new Error('Synthetic fixture refuses outbound GitHub requests');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!['token ' + token, 'Bearer ' + token].includes(headers.get('authorization')))
      throw new Error('Synthetic fixture refuses real GitHub credentials');
    return Response.json({ id: fixture.githubUserId, login: fixture.githubLogin });
  };
  return () => { childProcess.execFile = originalExec; syncBuiltinESMExports(); globalThis.fetch = originalFetch; globalThis.__ghAuthToken = priorToken; };
}

if (process.argv.includes('--prepare')) {
  console.log(prepareIdentityFixture(process.argv[process.argv.indexOf('--prepare') + 1]));
} else if (process.env.DAO_WORKBENCH_IDENTITY_FIXTURE) {
  const path = process.env.DAO_WORKBENCH_IDENTITY_FIXTURE;
  process.env.PAPERCUSP_ANNOUNCE_IDENTITY_CACHE = join(dirname(path), 'announce.json');
  process.env.PAPERCUSP_IDENTITY_MODE = 'load-only';
  installIdentityFixture(JSON.parse(readFileSync(path, 'utf8')));
}
