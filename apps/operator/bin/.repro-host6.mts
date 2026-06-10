import { serve } from '@hono/node-server';
const { runBootstrap } = await import('./host-bootstrap');
await runBootstrap();
const { handler } = await import('./host-handler');
serve({ fetch: handler, port: 3178, hostname: '127.0.0.1' });
console.log('LISTENING 3178');
// keep alive
setInterval(() => {}, 10000);
