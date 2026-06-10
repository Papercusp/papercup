const { runBootstrap } = await import('./host-bootstrap');
await runBootstrap();
const { handler } = await import('./host-handler');
const mk = () => new Request('http://x/api/agent-tools/tasks/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('CALL1:', (await handler(mk())).status);
await new Promise((r) => setTimeout(r, 10000));
console.log('CALL2:', (await handler(mk())).status);
process.exit(0);
