/**
 * POST /api/agent-mcp/operator-openai-test — OpenAI TTS connection test.
 * Ported from app/api/agent-mcp/operator-openai-test/route.ts. `auth: 'public'`.
 */
import { readOpenAiKey } from '@/lib/voice-credentials';
import { testOpenAiConnection } from '@/lib/voice-engines/openai';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'POST',
  path: '/agent-mcp/operator-openai-test',
  auth: 'public',
  async handler(req) {
    let body: { apiKey?: unknown } = {};
    try { body = await req.json(); } catch { /* fall through */ }
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0
      ? body.apiKey
      : await readOpenAiKey();
    if (!apiKey) {
      return Response.json({ ok: false, error: 'no API key configured' }, { status: 400 });
    }
    const result = await testOpenAiConnection(apiKey);
    return Response.json(result);
  },
});
