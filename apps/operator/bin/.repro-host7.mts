import { serve } from '@hono/node-server';
const { runBootstrap } = await import('./host-bootstrap');
await runBootstrap();
const { handler } = await import('./host-handler');
const amcp = await import('@papercusp/agent-mcp');
const tooldef = await import('@papercusp/tooldef');
console.log('CLASS IDENTITY agent-mcp === tooldef:', (amcp as any).UnauthorizedToolError === (tooldef as any).UnauthorizedToolError);
const tool = (amcp as any).lookupByHttpPath('/api/agent-tools/tasks/list');
console.log('tool found:', !!tool, 'pluginName:', tool?.pluginName);
const orig = tool.fn;
tool.fn = async (input: unknown, ctx: unknown) => {
  try { return await orig(input, ctx); }
  catch (e: any) {
    console.error('THROWN ctor=', e?.constructor?.name, 'name=', e?.name,
      'iof-amcp=', e instanceof (amcp as any).UnauthorizedToolError,
      'iof-tooldef=', e instanceof (tooldef as any).UnauthorizedToolError);
    throw e;
  }
};
serve({ fetch: handler, port: 3177, hostname: '127.0.0.1' });
console.log('LISTENING 3177');
// in-process comparison call
const res2 = await handler(new Request('http://127.0.0.1:3177/api/agent-tools/tasks/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
console.log('INPROC STATUS:', res2.status);
setInterval(() => {}, 10000);
