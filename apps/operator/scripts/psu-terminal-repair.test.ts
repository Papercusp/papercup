// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyTerminalIdentityRepair, terminalIdentityRepairSource, LEGACY_IDENTITY_FUNCTION } from './psu-terminal-repair.mjs';
import { createCdpClient } from '../../../scripts/cdp-inspector.mjs';

const legacy = LEGACY_IDENTITY_FUNCTION;

describe('terminal identity repair adoption', () => {
  it('refuses unknown source and preserves unrelated loaded code byte for byte', () => {
    expect(() => terminalIdentityRepairSource('export function other() {}')).toThrow('Unknown');
    expect(() => terminalIdentityRepairSource(legacy + '\n' + legacy)).toThrow('ambiguous');
    const result = terminalIdentityRepairSource('/* prefix */\n' + legacy + '\n/* suffix */');
    expect(result.needed).toBe(true);
    expect(result.source.startsWith('/* prefix */\n')).toBe(true);
    expect(result.source.endsWith('\n/* suffix */')).toBe(true);
    expect(result.source).toContain('holderPid: nativePid');
    expect(result.source).toContain('if (holder.pid !== nativePid) return null;');
    expect(terminalIdentityRepairSource(result.source).needed).toBe(false);
    expect(terminalIdentityRepairSource('export function readLinuxProcessFlockText() {}\n' + legacy).needed).toBe(false);
  });

  it('does not mutate on preview, refuses a concurrent source change and surfaces V8 rejection', async () => {
    const send = vi.fn(async (method: string, args: any) => {
      if (method === 'Debugger.getScriptSource') return { scriptSource: legacy + '\nchanged' };
      return { status: 'Ok' };
    });
    const client = { send } as any;
    expect((await applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy })).applied).toBe(false);
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0][1].dryRun).toBe(true);
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('changed after preview');
    expect(send.mock.calls.filter(([, args]) => args.dryRun === undefined && args.scriptSource)).toHaveLength(0);
    send.mockImplementation(async () => ({ status: 'BlockedByActiveFunction' }));
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('V8 refused');
  });

  it.skipIf(process.platform !== 'linux')('updates a captured ESM callback in a real live process without replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-identity-adoption-'));
    const file = join(root, 'legacy.mjs');
    // A real ESM callback, captured before the edit, exercises V8 adoption rather
    // than merely testing the generated source string. Global and local readers
    // have distinguishable observations independent of the return value.
    writeFileSync(file, `import { readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      globalThis.globalReads=0;
      const resolveLinuxCodexStartupPid=()=>process.pid;
      const codexThreadWriterHolder=(home,id,options)=>{
        if (options.readProcLocks) { options.readProcLocks(); globalThis.localReads=(globalThis.localReads||0)+1; }
        else globalThis.globalReads++;
        return {held:true,pid:process.pid,sessionId:'native-thread'};
      };
      ${legacy}
      globalThis.captured=()=>codexNativeIdForPty('/home',process.pid);
      setInterval(()=>{},1000);
    `);
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let client: ReturnType<typeof createCdpClient> | undefined;
    let stderr = '';
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Inspector not ready: ' + stderr)), 5000);
        child.stderr.on('data', (data) => { stderr += data; const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
        child.once('error', reject);
      });
      client = createCdpClient(url, { requestTimeoutMs: 3000 });
      await client.connect();
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        ready = (await client.evaluate('typeof globalThis.captured === "function"', { returnByValue: true })).result.value;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(ready).toBe(true);
      const sample = async () => (await client!.evaluate('({pid:process.pid,result:captured(),globalReads,localReads:globalThis.localReads||0})', { returnByValue: true })).result.value;
      const before = await sample();
      expect(before).toMatchObject({ pid: child.pid, result: 'native-thread', globalReads: 1, localReads: 0 });
      const parsed: any[] = [];
      client.ws.on('message', (data: any) => { const m = JSON.parse(String(data)); if (m.method === 'Debugger.scriptParsed' && m.params.url === pathToFileURL(file).href) parsed.push(m.params); });
      await client.send('Debugger.enable');
      expect(parsed).toHaveLength(1);
      const scriptId = parsed[0].scriptId;
      const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId });
      const receipt = await applyTerminalIdentityRepair(client, { scriptId, source: scriptSource, apply: true });
      expect(receipt.applied).toBe(true);
      expect(await sample()).toMatchObject({ pid: before.pid, result: 'native-thread', globalReads: 1, localReads: 1 });
      expect((await applyTerminalIdentityRepair(client, { scriptId,
        source: (await client.send('Debugger.getScriptSource', { scriptId })).scriptSource, apply: true })).needed).toBe(false);
    } finally {
      client?.close();
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
