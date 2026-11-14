/** Register inference only. MCP discovery, transport and execution belong to installed OMP. */
export const ompLifecycleProvider = `
import { writeFileSync } from 'node:fs';
export default function(pi) {
  const phase = (name, detail = {}) => {
    if (process.env.OMP_PROOF_PHASE_FILE) writeFileSync(process.env.OMP_PROOF_PHASE_FILE,
      JSON.stringify({ name, at: Date.now(), ...detail }) + '\\n', { flag: 'a' });
  };
  phase('extension-entry');
  let turn = 0;
  let control = 0;
  let readiness;
  const expectedDispatcher = process.env.OMP_PROOF_MCP_DISPATCHER;
  // OMP discovers uncached MCP servers in the background. Synchronize with
  // its exact model-visible dispatcher before emitting an immediate fixture
  // turn; a guessed name or a fixed inference delay cannot prove readiness.
  pi.on('before_agent_start', async () => {
    if (!expectedDispatcher) throw new Error('OMP proof did not declare its expected MCP dispatcher');
    const startedAt = Date.now();
    phase('before-agent-start');
    for (;;) {
      const names = pi.getActiveTools();
      const dispatcher = names.find(name => name === expectedDispatcher);
      if (dispatcher) {
        readiness = { names, dispatcher, elapsedMs: Date.now() - startedAt };
        phase('mcp-ready', readiness);
        return;
      }
      if (Date.now() - startedAt >= 10000) {
        phase('mcp-readiness-timeout', { expectedDispatcher, names });
        throw new Error('OMP managed MCP dispatcher did not become active: expected ' +
          expectedDispatcher + '; actual ' + JSON.stringify(names));
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  });
  pi.registerProvider('surface-fixture', {
    api: 'surface-fixture-api', apiKey: 'local-fixture-only', baseUrl: 'http://unused.invalid',
    models: [{ id: 'proof', name: 'Local lifecycle proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      if (++turn > 6) throw new Error('Unexpected inference turn');
      phase('inference-turn', { turn });
      const surface = process.env.OMP_PROOF_SURFACE;
      const names = (context.tools ?? []).map(tool => tool.name);
      const reply = id => context.messages.find(row => row.role === 'toolResult' && row.toolCallId === id);
      let dispatcher = names.find(name => name === expectedDispatcher);
      let devicePath;
      let call;
      // Installed OMP may mount MCP tools as devices instead of advertising
      // them at top level. Let OMP perform discovery and execution through
      // its real read/write tools; never synthesize a dispatcher or path.
      if (!dispatcher) {
        if (!names.includes('read') || !names.includes('write'))
          throw new Error('OMP model catalog lacks MCP dispatch and device transport: ' + JSON.stringify(names));
        const listingId = surface + '_discovery';
        const listing = reply(listingId);
        if (!listing) call = { type: 'toolCall', id: listingId, name: 'read', arguments: { path: 'xd://' } };
        else {
          if (listing.isError) throw new Error('OMP device discovery failed: ' + JSON.stringify(listing));
          const paths = JSON.stringify(listing.content).match(new RegExp('xd://[A-Za-z0-9_:-]+', 'g')) ?? [];
          devicePath = paths.find(path => path.slice(5) === readiness?.dispatcher);
          if (!devicePath) throw new Error('OMP device listing lacks the registered MCP dispatcher: ' + JSON.stringify(listing));
          const schemaId = surface + '_schema';
          const schema = reply(schemaId);
          if (!schema) call = { type: 'toolCall', id: schemaId, name: 'read', arguments: { path: devicePath } };
          else {
            if (schema.isError) throw new Error('OMP device schema read failed: ' + JSON.stringify(schema));
            dispatcher = devicePath.slice(5);
          }
        }
      }
      if (!call) {
        const id = surface + '_' + ['native', 'managed', 'refusal'][control];
        const args = control === 0 ? { command: "printf 'OMP_NATIVE_ESCAPE'" }
          : control === 1 ? { name: 'capability:bash', args: {
            command: "printf 'OMP_MANAGED_OK'", cwd: process.cwd(), timeout: 10000, yield_after_ms: 15000 } }
          : { name: 'capability:__omp_missing_control__', args: {} };
        if (control < 3) call = { type: 'toolCall', id,
          name: control === 0 ? 'bash' : devicePath ? 'write' : dispatcher,
          arguments: control === 0 || !devicePath ? args : { path: devicePath, content: JSON.stringify(args) } };
        control++;
      }
      const tool = Boolean(call);
      const content = tool ? [call]
        : [{ type: 'text', text: 'OMP lifecycle proof complete.' }];
      if (!tool) {
        writeFileSync(process.env.OMP_PROOF_RESULT, JSON.stringify({
          names, messages: context.messages, dispatcher, devicePath, readiness, turns: turn,
          replies: context.messages.filter(row => row.role === 'toolResult' &&
            [surface + '_native', surface + '_managed', surface + '_refusal'].includes(row.toolCallId)) }));
        phase('proof-complete');
      }
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: message };
        if (tool) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
        yield { type: 'done', reason: message.stopReason, message };
      }, result: async () => message };
    }
  });
}
`;
