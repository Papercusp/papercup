import '../../packages/operator-core/lib/memory/configure';
import { memoryHost } from '@papercusp/memory';

const creds = await memoryHost().getCredentials();

async function probeAnthropic(label: string, key: string | undefined) {
  if (!key) return console.log(label, '→ missing');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
  });
  console.log(label, '→ HTTP', r.status, r.status === 200 ? 'VALID' : (await r.text()).slice(0, 120));
}

async function probeOpenAi(label: string, key: string | undefined) {
  if (!key) return console.log(label, '→ missing');
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  console.log(label, '→ HTTP', r.status, r.status === 200 ? 'VALID' : (await r.text()).slice(0, 120));
}

await probeAnthropic('creds.anthropic', creds.anthropic_api_key);
await probeAnthropic('env.ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
await probeOpenAi('creds.openai', creds.openai_api_key);
process.exit(0);
