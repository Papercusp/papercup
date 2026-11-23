import { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { applyManagedPolicyEnv } from '@agentclientprotocol/claude-agent-acp/dist/managed-policy.js';
import { loadConfig, Operator } from './operator.mjs';
import { ManagedAgent } from './session.mjs';

console.log = console.info = console.debug = console.warn = console.error;
if (process.argv[2] === '--version') {
  process.stderr.write('psu-acp 0.1.0\n');
} else {
  if (process.argv[2] !== '--config' || !process.argv[3]) throw new Error('Usage: psu-acp --config /path/to/config.json');
  const config = await loadConfig(process.argv[3]);
  // `--member`: a member its leader's front started, its launch job on fd 3. `--member-job <file>`:
  // a member the leader's client hosts, started by that client from the job it was handed.
  const member=process.argv[4]==='--member' ? JSON.parse(readFileSync(3,'utf8'))
    : process.argv[4]==='--member-job' && process.argv[5]
      ? {...JSON.parse(readFileSync(process.argv[5],'utf8')),clientHosted:true} : null;
  if (!process.env.CLAUDE_CODE_EXECUTABLE && config.executable) process.env.CLAUDE_CODE_EXECUTABLE = config.executable;
  await applyManagedPolicyEnv();
  let agent;
  let stopping;
  function stop(code) {
    if (!stopping) {
      const hardStop = setTimeout(() => process.exit(code || 1), 2000);
      stopping = Promise.resolve().then(() => agent?.dispose()).catch(error => {
        console.error('Papercusp shutdown:',error.message);
      }).finally(() => { clearTimeout(hardStop); process.exit(code); });
    }
    return stopping;
  }
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const connection = new AgentSideConnection(client => {
    agent = new ManagedAgent(client, new Operator(config,member), () => setTimeout(() => stop(1),100));
    const handlers = {};
    for (const method of ['initialize','newSession','loadSession','resumeSession','unstable_forkSession','setSessionConfigOption',
      'prompt','cancel','extMethod','closeSession']) {
      handlers[method] = async (...args) => {
        try { return await agent[method](...args); }
        catch (error) {
          if (error instanceof RequestError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (/process exited unexpectedly|session has ended/i.test(message)) {
            throw new RequestError(-32603,message,{errorKind:'transport_lost'});
          }
          throw new RequestError(-32000,message);
        }
      };
    }
    return handlers;
  },stream);
  process.once('SIGTERM', () => stop(0));
  process.once('SIGINT', () => stop(0));
  connection.closed.then(() => stop(0), () => stop(1));
}
