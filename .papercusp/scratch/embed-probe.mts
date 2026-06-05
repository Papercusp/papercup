import '../../packages/operator-core/lib/memory/configure';
import { memoryHost } from '@papercusp/memory';

const host = memoryHost();
const resolved = await host.resolveEmbedder();
console.log('resolveEmbedder →', resolved.mode, 'reason' in resolved ? (resolved as { reason?: string }).reason : '');
if (resolved.mode !== 'disabled') {
  const t0 = performance.now();
  try {
    const v = await resolved.embed('hello world embedding probe');
    console.log('embed OK dims=', v.length, 'ms=', (performance.now() - t0).toFixed(0));
  } catch (e) {
    console.log('embed FAILED:', (e as Error).message);
  }
}
const creds = await host.getCredentials();
console.log('anthropic key:', creds.anthropic_api_key ? 'SET' : 'missing', '| openai key:', creds.openai_api_key ? 'SET' : 'missing');
process.exit(0);
