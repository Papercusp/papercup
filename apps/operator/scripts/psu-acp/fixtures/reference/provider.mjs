// Deterministic inference for the network-isolated native reference fixture.
// The real Claude executable and ACP adapter still own the session and its events.
import { EventStreamCodec } from '@smithy/core/event-streams';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const codec = new EventStreamCodec(bytes => new TextDecoder().decode(bytes), text => Buffer.from(text));
const answer = 'Native managed fixture completed.\n/work/result.txt';
const fixtureWrite = {
  type: 'tool_use', id: 'toolu_psu_acp_receipt', name: 'Write',
  input: { file_path: '/work/permission-receipt.txt', content: 'approved fixture receipt\n' },
};

function sendEvent(response, event) {
  const payload = Buffer.from(JSON.stringify(event)).toString('base64');
  response.write(codec.encode({
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: 'chunk' },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: Buffer.from(JSON.stringify({ bytes: payload })),
  }));
}

createServer(async (request, response) => {
  try {
    if (request.url === '/ready') {
      response.end('ready');
      return;
    }
    if (request.url === '/mcp') {
      const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
      const digest = auth && createHash('sha256').update(auth[1]).digest('hex');
      if (!digest || digest !== process.env.FIXTURE_MCP_TOKEN_SHA256) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      appendFileSync('/work/mcp-requests.jsonl', JSON.stringify({ method: rpc.method, digest }) + '\n');
      const server = new McpServer({ name: 'fixture-receipts', version: '1' });
      server.registerTool('status', { description: 'Read the fixture status.', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'ready' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on('close', () => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, rpc);
      return;
    }
    const route = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/.exec(request.url);
    if (request.method !== 'POST' || !route) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const model = decodeURIComponent(route[1]);
    const containsProbe = input.messages.some(({ role, content }) => role === 'user' && (
      typeof content === 'string' ? content.includes('managed fixture receipt') :
        content.some(block => block.type === 'text' && block.text.includes('managed fixture receipt'))
    ));
    const receiptRequested = input.messages.some(({ role, content }) => role === 'user' &&
      (typeof content === 'string' ? content.includes('exercise the fixture Write') :
        content.some(block => block.type === 'text' && block.text.includes('exercise the fixture Write'))));
    const hasReceiptResult = input.messages.some(({ content }) => Array.isArray(content) && content.some(
      block => block.type === 'tool_result' && block.tool_use_id === fixtureWrite.id,
    ));
    const useTool = receiptRequested && !hasReceiptResult && input.tools?.some(tool => tool.name === 'Write');
    const block = useTool ? fixtureWrite : { type: 'text', text: answer };
    const stopReason = useTool ? 'tool_use' : 'end_turn';
    const message = {
      id: 'msg_' + randomUUID(), model, type: 'message', role: 'assistant', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 14, output_tokens: 0 },
    };
    appendFileSync('/work/provider-requests.jsonl', JSON.stringify({
      messageId: message.id, model, operation: route[2], containsProbe, effort: input.output_config?.effort ?? null,
      emittedToolId: useTool ? fixtureWrite.id : null, hasReceiptResult,
    }) + '\n');
    if (route[2] === 'invoke') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, content: [block],
        stop_reason: stopReason, usage: { input_tokens: 14, output_tokens: 8 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream',
      'x-amzn-bedrock-content-type': 'application/json' });
    sendEvent(response, { type: 'message_start', message });
    sendEvent(response, { type: 'content_block_start', index: 0,
      content_block: useTool ? { ...fixtureWrite, input: {} } : { type: 'text', text: '' } });
    sendEvent(response, { type: 'content_block_delta', index: 0, delta: useTool ?
      { type: 'input_json_delta', partial_json: JSON.stringify(fixtureWrite.input) } : { type: 'text_delta', text: answer } });
    sendEvent(response, { type: 'content_block_stop', index: 0 });
    sendEvent(response, { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 8 } });
    sendEvent(response, { type: 'message_stop' });
    response.end();
  } catch (error) {
    console.error('Reference fixture request failed', error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
}).listen(8911, '127.0.0.1');
