// @vitest-environment node
/** Installed Codex, native transcripts, managed PTYs and context bootstrap are
 * real. The provider, inspection service and resume callback are local fixtures;
 * this does not certify the production operator, custody store or work router. */
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, handoffPathFor, readHostHandoffForParentPid } from '../scripts/psu-pty-host.mjs';
import { mintCarryRespawnArgs, codexThreadWriterHolder } from '../scripts/psu-launcher.mjs';
import { launchIdentityAssumeHandoff, makeIdentityAssumeHostPort,
  prepareIdentityAssumeCheckpoint } from '../scripts/psu-identity-assume.mjs';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from
  '../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge';

type Row = Record<string, any>;
const productionState = vi.hoisted(() => ({ sql: undefined as any, homes: new Map<string, string>() }));
vi.mock('@papercusp/db-org', async original => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => productionState.sql ? { sql: productionState.sql } : actual.getOrgPg() };
});
vi.mock('@papercusp/orchestrator/session-launch-dirs', async original => {
  const actual = await original<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return { ...actual, codexHomeForSessionKey: (key: string | number) =>
    productionState.homes.get(String(key)) ?? actual.codexHomeForSessionKey(key) };
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
};
async function control(sock: string, message: unknown): Promise<Row> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock); let bytes = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Native handoff control timed out')));
    socket.once('error', reject); socket.on('data', data => { bytes += data; });
    socket.once('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    socket.once('connect', () => socket.end(JSON.stringify(message)));
  });
}
function callOutputs(value: any): Row[] {
  if (typeof value === 'string') { try { return callOutputs(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(callOutputs);
  if (!value || typeof value !== 'object') return [];
  return String(value.type).endsWith('call_output') ? [value] : Object.values(value).flatMap(callOutputs);
}

async function nativeJourney(mode: 'native-resume' | 'checkpoint', production = false) {
    const root = mkdtempSync('/tmp/assume-native-journey-');
    const marker = { target: `TARGET_HISTORY_${randomUUID()}`, caller: `CALLER_HISTORY_${randomUUID()}`,
      checkpoint: `TARGET_CHECKPOINT_${randomUUID()}` };
    const owners = { caller: `test-assume-caller-${randomUUID()}`, target: `test-assume-target-${randomUUID()}` };
    const homes = { caller: join(root, 'caller'), target: join(root, 'target') };
    for (const home of Object.values(homes)) mkdirSync(home);
    const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
    let output = '';
    const io = { stdin, stdout: { isTTY: false, columns: 120, rows: 40,
      write(data: string) { output += data; return true; } } };
    let phase: 'seed' | 'caller' | 'target' | 'return' = 'seed';
    let port = 0, issued = false, targetReady = false;
    const requests: Array<{ phase: string; body: Row }> = [], errors: string[] = [], nativeResults: string[] = [];
    const hosts: McpServer[] = [];
    const orders: Row[] = [], inspections = new Map<string, Row>();
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>(resolve => { releaseTarget = resolve; });
    const runs: Array<{ owner: string; signals: EventEmitter; done: Promise<number> }> = [];
    const transcript = (key: keyof typeof homes, id?: string) => {
      const files = readdirSync(join(homes[key], 'sessions'), { recursive: true }).map(String)
        .filter(path => path.endsWith('.jsonl'));
      const found = files.map(path => readFileSync(join(homes[key], 'sessions', path), 'utf8'))
        .filter(text => !id || JSON.parse(text.split('\n')[0]).payload.id === id);
      if (found.length !== 1) throw new Error(`Expected one ${key} transcript, found ${found.length}`);
      return found[0];
    };
    const nativeId = (key: keyof typeof homes) => JSON.parse(transcript(key).split('\n')[0]).payload.id as string;
    const latestNativeId = (key: keyof typeof homes) => {
      const files = readdirSync(join(homes[key], 'sessions'), { recursive: true }).map(String)
        .filter(path => path.endsWith('.jsonl'));
      return files.map(path => JSON.parse(readFileSync(join(homes[key], 'sessions', path), 'utf8').split('\n')[0]))
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).at(-1)!.payload.id as string;
    };
    let real: Awaited<ReturnType<typeof import('../vitest-shims/identity-assume-production').productionAssumeFixture>> | undefined;
    let accepted: Row | undefined, targetWork = '';
    const routed: Row[] = [];
    const inspect = async (request: Row, afterExit = false, action = 'observe') => {
      if (real) return real.inspect(request, afterExit, action);
      const result = inspections.get(request.transitionKey);
      if (!result || JSON.stringify(result.preparation.caller) !== JSON.stringify(request.caller))
        throw new Error('Fixture inspection refused an unknown caller');
      return result;
    };
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        if (req.url === '/inspect') {
          const result = await inspect(body.request, body.afterExit, body.action);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
        }
        if (req.url === '/mcp') {
          const host = new McpServer({ name: 'native-handoff-fixture', version: '1' }); hosts.push(host);
          host.registerTool('handoff_fixture', { inputSchema: {} }, async () => {
            if (phase !== 'caller' && phase !== 'target') throw new Error('Handoff outside an execution phase');
            if (real && phase === 'target') {
              const result = await real.probe(owners.target, targetWork);
              routed.push(result);
              return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
            if (real) {
              const id = nativeId('caller');
              await vi.waitFor(() => expect(JSON.parse(readFileSync(metaPathFor(owners.caller), 'utf8'))
                .nativeSessionId).toBe(id), { timeout: 5000 });
              const registration = await real.register(owners.caller, id, root, false);
              productionState.homes.set(String(registration), homes.caller);
              const plan = await real.prepare(owners.caller, owners.target, mode);
              accepted = await real.commit(plan);
              if (accepted.state !== 'handoff-accepted') throw new Error('Production commit: ' + JSON.stringify({
                state: accepted.state, reason: accepted.reason, trace: real.trace }));
              await real.send(owners.target, 'DURING_HANDOFF');
              return { content: [{ type: 'text', text: JSON.stringify(accepted) }] };
            }
            const key = phase, other = key === 'caller' ? 'target' : 'caller';
            const meta = JSON.parse(readFileSync(metaPathFor(owners[key]), 'utf8'));
            const caller = { ownerId: owners[key], workspaceId: 'native-context-fixture',
              nativeSessionId: latestNativeId(key), nativePid: meta.ptyPid,
              hostId: meta.identityAssume.hostId, attachmentId: meta.identityAssume.attachmentId,
              childGeneration: meta.childGeneration };
            const request = { caller, transitionKey: `session-assume:${hash(randomUUID())}`,
              preparationHash: hash(randomUUID()), recoveryRef: `carry-note:${key}`,
              recoveryHash: hash(randomUUID()), expiresAt: Date.now() + 120_000 };
            const target = { ownerId: owners[other], workspaceId: caller.workspaceId, advSessionId: other === 'target' ? 2 : 1,
              backend: 'codex', role: 'su', nativeSessionId: nativeId(other),
              executionNativeSessionId: key === 'caller' && mode === 'checkpoint' ? null : nativeId(other),
              context: { mode: key === 'caller' ? mode : 'native-resume',
                ref: key === 'caller' && mode === 'checkpoint' ? 'carry-note:target' : nativeId(other),
                sha256: hash(marker.checkpoint), revision: 'fixture' },
              ...(key === 'target' ? { returnFrom: { transitionKey: orders[0].assume.request.transitionKey } } : {}) };
            inspections.set(request.transitionKey, { ok: true, state: 'handoff-accepted',
              transitionKey: request.transitionKey, preparationHash: request.preparationHash,
              preparation: { caller, target, expiresAt: request.expiresAt }, checkpointBody: marker.checkpoint,
              recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash,
                returnRef: { ownerId: caller.ownerId } } });
            for (const action of ['freeze', 'queue']) expect(await control(meta.sock,
              { v: 1, mode: 'identity-assume', ownerId: caller.ownerId, action, request })).toMatchObject({ ok: true });
            return { content: [{ type: 'text', text: JSON.stringify({ transitionKey: request.transitionKey,
              preparationFingerprint: request.preparationHash, state: 'handoff-accepted', durable: true,
              preparation: { caller: { ...caller, backend: 'codex' } },
              recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } }) }] };
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await host.connect(transport); await transport.handleRequest(req, res, body); return;
        }
        if (req.url !== '/v1/responses') { res.writeHead(200); res.end('{}'); return; }
        requests.push({ phase, body }); res.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = (text: string) => res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({
          model: 'gpt-6-sol', text, inputTokens: 0, outputTokens: 0 })));
        if (phase === 'seed') { finish(marker.target); return; }
        if (phase === 'return') { finish('CALLER_RETURNED'); return; }
        const results = callOutputs(body.input).filter(row => row.call_id === `handoff-${phase}`);
        if (results.length) {
          nativeResults.push(JSON.stringify(results).slice(0, 1800));
          if (phase === 'target') { targetReady = true; await targetGate; }
          finish('HANDOFF_NATIVE_COMPLETE'); return;
        }
        const available = [...(body.tools ?? []), ...(body.input ?? []).flatMap(
          (item: Row) => Array.isArray(item.tools) ? item.tools : [])];
        const namespace = available.find(tool => tool.type === 'namespace' && tool.tools?.some((t: Row) => t.name === 'handoff_fixture'));
        const direct = available.find(tool => tool.type === 'function' && tool.name?.endsWith('__handoff_fixture'));
        const executor = available.find(tool => tool.type === 'namespace' &&
          tool.tools?.some((t: Row) => t.type === 'custom' && t.name === 'exec'));
        if (issued || !namespace && !direct && !executor && !available.some(tool => tool.type === 'tool_search')) {
          finish('AUXILIARY_RESPONSE'); return;
        }
        const discovery = !namespace && !direct && !executor;
        issued = !discovery;
        const call = discovery ? { id: 'discover', type: 'tool_search_call', execution: 'client',
          call_id: 'discover-handoff', status: 'completed', arguments: { query: 'handoff_fixture', limit: 1 } } : executor
          ? { id: `call-${phase}`, type: 'custom_tool_call', namespace: executor.name, name: 'exec',
            call_id: `handoff-${phase}`, status: 'completed',
            input: "const tool=ALL_TOOLS.find(t=>t.name.endsWith('__handoff_fixture')); if(!tool)throw new Error('Missing handoff fixture');text(await tools[tool.name]({}));" }
          : { id: `call-${phase}`, type: 'function_call', call_id: `handoff-${phase}`, status: 'completed',
            ...(namespace ? { namespace: namespace.name } : {}), name: direct?.name ?? 'handoff_fixture', arguments: '{}' };
        const event = (type: string, payload: Row) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        res.end(event('response.output_item.added', { output_index: 0,
          item: { ...call, status: 'in_progress', ...(executor ? { input: '' } : { arguments: discovery ? {} : '' }) } }) +
          event('response.output_item.done', { output_index: 0, item: call }) +
          event('response.completed', { response: { ...codexCliResponsesBody({ model: 'gpt-6-sol',
            text: '', inputTokens: 0, outputTokens: 0 }), output: [call] } }));
      } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    const baseArgs = () => ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
      ...Object.entries({ model: 'gpt-6-sol', model_provider: 'assume_fixture',
        'model_providers.assume_fixture.name': 'Offline native context fixture',
        'model_providers.assume_fixture.base_url': `http://127.0.0.1:${port}/v1`,
        'model_providers.assume_fixture.wire_api': 'responses',
        'model_providers.assume_fixture.requires_openai_auth': false,
        'model_providers.assume_fixture.supports_websockets': false,
        'model_providers.assume_fixture.request_max_retries': 0,
        'model_providers.assume_fixture.stream_max_retries': 0,
        'features.apps': false, 'features.hooks': false, web_search: 'disabled',
        [`projects.${JSON.stringify(root)}.trust_level`]: 'trusted' })
        .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
    const start = (key: keyof typeof homes, args: string[], inherited?: Row) => {
      const signals = new EventEmitter();
      if (production) {
        const file = join(root, 'psu-pty-host-' + key + '.mjs');
        const hostModule = new URL('../scripts/psu-pty-host.mjs', import.meta.url).href;
        const assumeModule = new URL('../scripts/psu-identity-assume.mjs', import.meta.url).href;
        // This subprocess really owns the production host and native child.
        // Discovery checks its command line; no discovery verifier is replaced.
        writeFileSync(file, [
          'import {hostThroughPty,writeHostHandoff} from ' + JSON.stringify(hostModule) + ';',
          'import {makeIdentityAssumeHostPort} from ' + JSON.stringify(assumeModule) + ';',
          'import {readdirSync,readFileSync} from "node:fs"; import {join} from "node:path";',
          'const inspect=async(request,afterExit=false,action="observe")=>{const r=await fetch(' +
            JSON.stringify('http://127.0.0.1:' + port + '/inspect') +
            ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request,afterExit,action})});' +
            'if(!r.ok)throw new Error("Inspection refused");return r.json()};',
          'const latest=()=>{try{const root=join(process.env.CODEX_HOME,"sessions");return readdirSync(root,{recursive:true})' +
            '.map(String).filter(p=>p.endsWith(".jsonl")).map(p=>JSON.parse(readFileSync(join(root,p),"utf8").split("\\n")[0]))' +
            '.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp))).at(-1)?.payload.id??null}catch{return null}};',
          'const identityAssume=makeIdentityAssumeHostPort({ownerId:process.env.PAPERCUSP_SID,inspect,reexecCode:75,' +
            'hostId:' + JSON.stringify(inherited?.hostId ?? null) + ',attachmentId:' + JSON.stringify(inherited?.attachmentId ?? null) +
            ',writeHandoff:(owner,record)=>{const path=writeHostHandoff(owner,record);' +
            'if(path)process.send?.({handoff:JSON.parse(readFileSync(path,"utf8"))});return path}});',
          'const code=await hostThroughPty({command:"codex",args:' + JSON.stringify(args) +
            ',cwd:' + JSON.stringify(root) + ',ownerId:process.env.PAPERCUSP_SID,env:process.env,' +
            'resolveRespawnNativeId:latest,identityAssume,onReexec:()=>{},emitCompacted:()=>null,onExit:()=>{},activityPersistMs:100,bridgeTty:false});',
          'process.exit(code);',
        ].join('\n'));
        const child = spawn(process.execPath, [file], { cwd: root,
          env: hermeticEnv({ CODEX_HOME: homes[key], TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
            PAPERCUSP_SID: owners[key], PAPERCUSP_WORKSPACE: 'native-context-fixture',
            PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.pid) }),
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
        child.on('message', (message: any) => { if (message.handoff) orders.push(message.handoff); });
        signals.on('SIGTERM', () => child.kill('SIGTERM'));
        const done = new Promise<number>((resolve, reject) => {
          child.once('error', reject); child.once('close', code => resolve(code ?? -1));
        });
        const run = { owner: owners[key], signals, done }; runs.push(run); return run;
      }
      const hostPort = makeIdentityAssumeHostPort({ ownerId: owners[key], inspect,
        reexecCode: 75, attachmentId: inherited?.attachmentId, hostId: inherited?.hostId,
        writeHandoff: (_owner: string, record: Row) => {
          // This same-process fixture cannot exit its Vitest parent. Pin the
          // real departed native PID as the predecessor for the helper seam.
          orders.push({ ...record, ownerId: owners[key], fromPid: record.assume.request.caller.nativePid });
          return handoffPathFor(owners[key]);
        } });
      const done = hostThroughPty({ command: 'codex', args, cwd: root, ownerId: owners[key],
        env: hermeticEnv({ CODEX_HOME: homes[key], TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_SID: owners[key], PAPERCUSP_WORKSPACE: 'native-context-fixture',
          PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
        resolveRespawnNativeId: () => { try { return latestNativeId(key); } catch { return null; } },
        identityAssume: hostPort, onReexec: () => {}, signalSource: signals,
        emitCompacted: () => null, onExit: () => {}, bridgeTty: false, io });
      const run = { owner: owners[key], signals, done }; runs.push(run); return run;
    };
    const diagnostics = () => JSON.stringify({ phase, errors, nativeResults, requests: requests.length, orders: orders.length,
      output: output.slice(-1200) });
    try {
      if (production) {
        const { productionAssumeFixture } = await import('../vitest-shims/identity-assume-production');
        real = await productionAssumeFixture('native-context-fixture', sql => { productionState.sql = sql; });
      }
      port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1',
        () => resolve((server.address() as net.AddressInfo).port)));
      for (const home of Object.values(homes)) {
        writeFileSync(join(home, 'AGENTS.md'), 'Isolated native context fixture persona.');
        writeFileSync(join(home, 'config.toml'),
          `[mcp_servers.fixture]\nurl = "http://127.0.0.1:${port}/mcp"\n`);
      }
      const seed = start('target', [...baseArgs(), 'Record the target history.']);
      await vi.waitFor(() => expect(output, diagnostics()).toContain(marker.target), { timeout: 20_000 });
      seed.signals.emit('SIGTERM'); await seed.done;
      const targetNative = nativeId('target');
      if (real) {
        const registration = await real.register(owners.target, targetNative, root, true);
        productionState.homes.set(String(registration), homes.target);
        await real.checkpoint(owners.target, marker.checkpoint);
        await real.send(owners.target, 'BEFORE_HANDOFF');
        targetWork = await real.assign(owners.target);
      }
      phase = 'caller'; issued = false;
      const caller = start('caller', [...baseArgs(), marker.caller]);
      await vi.waitFor(() => expect(orders, diagnostics()).toHaveLength(1), { timeout: 25_000 });
      const original = orders[0].assume.request.caller;
      await vi.waitFor(() => expect(alive(original.nativePid), diagnostics()).toBe(false), { timeout: 10_000 });
      expect(await caller.done).toBe(75);
      if (real) {
        const consumed = readHostHandoffForParentPid(process.pid, { ownerId: owners.caller });
        expect(consumed).not.toBeNull(); orders[0] = consumed;
        expect(alive(orders[0].fromPid)).toBe(false);
        await real.depart(owners.caller);
      }
      const callerNative = nativeId('caller');
      const resume = async (session: Row, options: Row) => {
        await options.managedAssume.verify();
        const key = session.coordOwnerId === owners.target ? 'target' : 'caller';
        let args = [...baseArgs(), 'resume', session.sessionId];
        let kickoff = options.kickoff;
        if (options.managedAssume.checkpoint) {
          const carry = prepareIdentityAssumeCheckpoint(session,
            options.managedAssume.checkpoint, args, { mint: mintCarryRespawnArgs,
              codexHome: homes[key], personaFile: null, home: root });
          args = carry.args;
          kickoff = [carry.carryText || options.managedAssume.checkpoint.body, kickoff].join('\n\n');
        }
        // Explicit phase prompt avoids relying on PTY ready-prompt timing.
        args.push(kickoff);
        return start(key, args, options.managedAssume);
      };
      const launch = (handoff: Row) => launchIdentityAssumeHandoff(handoff, { inspect,
        resolveSession: async (id: number) => real ? real.resolve(id) : ({ id, coordOwnerId: id === 2 ? owners.target : owners.caller,
          workspaceId: original.workspaceId, agent: 'codex', role: 'su', sessionId: id === 2 ? targetNative : callerNative }),
        accountFor: async () => ({ mode: 'default' }), resume, isAlive: alive, baseEnv: {} });
      phase = 'target'; issued = false;
      const targetRun = await launch(orders[0]);
      await vi.waitFor(() => expect(targetReady, diagnostics()).toBe(true), { timeout: 25_000 });
      const targetMeta = JSON.parse(readFileSync(metaPathFor(owners.target), 'utf8'));
      expect(targetMeta.identityAssume).toMatchObject({ hostId: original.hostId, attachmentId: original.attachmentId });
      expect(targetMeta.ptyPid).not.toBe(original.nativePid);
      const runningTargetNative = latestNativeId('target');
      expect(runningTargetNative === targetNative).toBe(mode === 'native-resume');
      expect(codexThreadWriterHolder(homes.target, runningTargetNative)).toMatchObject({ held: true });
      const targetInput = requests.filter(row => row.phase === 'target').map(row => JSON.stringify(row.body)).join('\n');
      expect(targetInput).not.toContain(marker.caller);
      expect(targetInput.includes(marker.target)).toBe(mode === 'native-resume');
      expect(targetInput.includes(marker.checkpoint)).toBe(mode === 'checkpoint');
      expect(orders).toHaveLength(1);
      if (real) {
        expect(routed).toHaveLength(1);
        expect(routed[0]).toMatchObject({ ownerId: owners.target,
          assignment: { id: targetWork, assignee: owners.target, observedBy: owners.target } });
        expect(routed[0].messages).toHaveLength(2);
        expect(new Set(routed[0].messages.map((row: Row) => row.id)).size).toBe(2);
        expect((await real.probe(owners.caller, targetWork)).messages).toEqual([]);
        expect((await real.probe(owners.target, targetWork)).messages).toEqual([]);
        const after = await real.send(owners.target, 'AFTER_HANDOFF');
        expect((await real.probe(owners.target, targetWork)).messages.map(row => row.id)).toEqual([after.msg_id]);
        expect((await real.load(accepted!.preparation))?.state).toBe('handoff-accepted');
        expect((await real.pause(owners.caller))?.transitionKey).toBe(accepted!.transitionKey);
        expect((await real.commit(accepted!.preparation)).replayed).toBe(true);
        expect(orders).toHaveLength(1);
        targetRun.signals.emit('SIGTERM'); releaseTarget(); await targetRun.done;
        expect(errors, diagnostics()).toEqual([]);
        return;
      }
      releaseTarget();
      await vi.waitFor(() => expect(alive(targetMeta.ptyPid), diagnostics()).toBe(false), { timeout: 10_000 });
      expect(await targetRun.done).toBe(75);
      expect(orders).toHaveLength(2); expect(alive(targetMeta.ptyPid)).toBe(false);
      phase = 'return'; issued = false;
      const returned = await launch(orders[1]);
      await vi.waitFor(() => expect(output, diagnostics()).toContain('CALLER_RETURNED'), { timeout: 20_000 });
      const returnMeta = JSON.parse(readFileSync(metaPathFor(owners.caller), 'utf8'));
      expect(returnMeta.identityAssume).toMatchObject({ hostId: original.hostId, attachmentId: original.attachmentId });
      expect(latestNativeId('caller')).toBe(callerNative);
      expect(requests.filter(row => row.phase === 'return').some(row => JSON.stringify(row.body).includes(marker.caller))).toBe(true);
      expect(transcript('caller', callerNative)).toContain('CALLER_RETURNED');
      expect(errors, diagnostics()).toEqual([]);
      returned.signals.emit('SIGTERM'); await returned.done;
    } finally {
      releaseTarget(); for (const run of runs) run.signals.emit('SIGTERM');
      await Promise.allSettled(runs.map(run => run.done));
      await Promise.allSettled(hosts.map(host => host.close()));
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await real?.dispose(); productionState.sql = undefined; productionState.homes.clear();
      rmSync(root, { recursive: true, force: true });
    }
}

it.each(['native-resume', 'checkpoint'] as const)(
  'resumes installed native target context and returns the caller on the same managed attachment (%s)',
  mode => nativeJourney(mode), 120_000);
it.each(['native-resume', 'checkpoint'] as const)(
  'uses production custody and routed responsibilities through the installed native handoff (%s)',
  mode => nativeJourney(mode, true), 180_000);
