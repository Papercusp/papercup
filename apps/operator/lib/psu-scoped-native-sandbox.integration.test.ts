import { it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';

const listen = (s: Server) => new Promise<number>((resolve, reject) => {
  s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
});
const stop = (s: Server) => new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()));

it('enforces the scoped boundary through the actual launcher and final managed PTY', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'psu-native-boundary-physical-'));
  const resultPath = join(cwd, 'native-result');
  const calls = [0, 0, 0];
  const servers = calls.map((_, i) => createServer((_req, res) => { calls[i]++; res.end(`endpoint-${i}`); }));
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    const [gateway, operator, forbidden] = await Promise.all(servers.map(listen));
    const codexHome = join(cwd, 'codex-home'); mkdirSync(codexHome);
    const env = hermeticEnv({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: codexHome,
      PAPERCUSP_SID: `test-scoped-native-${process.pid}`, PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '1',
      PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${operator}`,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: `http://127.0.0.1:${gateway}`, token: 'a'.repeat(64) }) });
    const reach = (port: number, extra = '') => `/usr/bin/curl --silent --show-error --fail --max-time 3 ${extra} http://127.0.0.1:${port}`;
    const script = [
      'set -e', `${reach(gateway)} > ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `${reach(operator)} >> ${quote(resultPath)}`, `printf '\\n' >> ${quote(resultPath)}`,
      `if ${reach(forbidden)}; then exit 41; fi`,
      `if ${reach(gateway, "--noproxy '*' ")}; then exit 42; fi`,
      `printf 'BOUNDARY_VERIFIED\\n' >> ${quote(resultPath)}`,
    ].join('\n');
    const launcher = fileURLToPath(new URL('../scripts/psu-launcher.mjs', import.meta.url));
    // This fixture runs the production runWrapper, not a replacement spawn.
    // Native work is only the local shell/socket check, with no model calls.
    const fixture = join(cwd, 'launcher-fixture.mjs');
    writeFileSync(fixture, `import { runWrapper } from ${JSON.stringify(launcher)};\nrunWrapper({wrapperBin:'/bin/sh',args:${JSON.stringify(['-c', script])},cwd:${JSON.stringify(cwd)},preserveCwd:true,envelopeEnv:process.env,reportSessionEndedImpl:async()=>{},onSpawn:()=>{}});\n`);
    const child = spawn(process.execPath, [fixture], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Final native PTY boundary fixture exceeded 20 seconds')); }, 20_000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', c => { clearTimeout(timer); resolve(c); });
    });
    expect(code, output).toBe(0);
    expect(existsSync(resultPath), output).toBe(true);
    expect(readFileSync(resultPath, 'utf8')).toBe('endpoint-0\nendpoint-1\nBOUNDARY_VERIFIED\n');
    expect(calls[0]).toBe(1);
    expect(calls[2]).toBe(0);
  } finally {
    await Promise.all(servers.map(s => s.listening ? stop(s) : Promise.resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
