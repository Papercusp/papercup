#!/usr/bin/env node
/**
 * UI control surface — presence, list_clients, get_state, dispatch.
 *
 * Stands up a fake browser tab (SSE consumer + result POSTer) and
 * drives the full agent ↔ UI round-trip end-to-end through the live
 * operator.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070';
const TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();

let pass = 0, fail = 0;
const check = (n, c) => (c ? (console.log(`  ✓ ${n}`), pass++) : (console.log(`  ✗ ${n}`), fail++));

function uuid() {
  const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function callTool(name, args, urlSuffix) {
  const r = await fetch(`${BASE}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name, arguments: args } }),
  });
  const body = await r.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data frame: ${body.slice(0,200)}`);
  const env = JSON.parse(dataLine.slice('data:'.length).trim());
  const text = env.result?.content?.[0]?.text;
  return { text, isError: env.result?.isError === true };
}

/**
 * Fake browser tab: subscribes to SSE, runs a registry of test
 * handlers (mirrors the browser dispatcher's built-ins + a couple of
 * feature handlers), posts results back.
 */
class FakeBrowser {
  constructor(clientId) {
    this.clientId = clientId;
    this.handlers = {
      'set_url': (args) => {
        const u = new URL(this.lastUrl);
        for (const [k, v] of Object.entries(args.params ?? {})) {
          if (v === null) u.searchParams.delete(k);
          else u.searchParams.set(k, String(v));
        }
        this.lastUrl = u.toString();
        return { url: this.lastUrl };
      },
      'snapshot': () => ({ found: true, text: 'fake-snapshot' }),
      'refresh-build': (args) => ({ feature_registered: true, args }),
    };
    this.lastUrl = `${BASE}/test?tab=initial`;
    this.aborter = new AbortController();
    this.running = (async () => {
      const r = await fetch(`${BASE}/api/ui/intents/stream?client_id=${encodeURIComponent(clientId)}`, {
        headers: { 'Accept': 'text/event-stream' },
        signal: this.aborter.signal,
      });
      if (!r.body) throw new Error('no SSE body');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        try {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          while (true) {
            const i = buf.indexOf('\n\n');
            if (i < 0) break;
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const msg = JSON.parse(dataLine.slice(5).trim());
            await this.execute(msg);
          }
        } catch (e) {
          if (this.aborter.signal.aborted) return;
          throw e;
        }
      }
    })();
  }
  async execute(msg) {
    let result = null, error = null;
    try {
      const h = this.handlers[msg.intent];
      if (!h) error = `unknown_intent: ${msg.intent}`;
      else result = await h(msg.args ?? {});
    } catch (e) { error = e.message; }
    await fetch(`${BASE}/api/ui/intents/${msg.id}/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result, error }),
    });
  }
  async heartbeat() {
    await fetch(`${BASE}/api/ui/presence`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, url: this.lastUrl, title: 'Fake Browser' }),
    });
  }
  async stop() { this.aborter.abort(); try { await this.running; } catch { /* */ } }
}

// --- Tests ---

const clientId = uuid();
const browser = new FakeBrowser(clientId);
await browser.heartbeat();
// Give the SSE stream a moment to attach.
await new Promise((r) => setTimeout(r, 500));

console.log('--- 1. presence + list_clients ---');
const list1 = JSON.parse((await callTool('ui:list_clients', {}, `?superuser=1&workspace=default`)).text);
check('list_clients includes new client', list1.clients.some((c) => c.client_id === clientId));
check('is_self false when ctx.uiClientId unset', list1.self_client_id === null);

console.log('--- 2. ctx.uiClientId default via &client= URL param ---');
const list2 = JSON.parse((await callTool('ui:list_clients', {}, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('self_client_id reflects URL param', list2.self_client_id === clientId);
check('is_self true for self row', list2.clients.find((c) => c.client_id === clientId)?.is_self === true);

console.log('--- 3. get_state with no client_id arg but ctx populated ---');
const state = JSON.parse((await callTool('ui:get_state', {}, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('client_id matches', state.client_id === clientId);
check('parsed params include tab=initial', state.params.tab === 'initial');
check('not stale', state.stale === false);

console.log('--- 4. get_state error path (no ctx, no arg) ---');
const noCtx = await callTool('ui:get_state', {}, `?superuser=1&workspace=default`);
check('errors when no client_id available', noCtx.text.startsWith('client_id_required'));

console.log('--- 5. dispatch built-in set_url ---');
const setUrlRes = JSON.parse((await callTool('ui:dispatch', { intent: 'set_url', args: { params: { tab: 'sessions' } }, timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('set_url status done', setUrlRes.status === 'done');
check('set_url result includes new URL', String(setUrlRes.result?.url ?? '').includes('tab=sessions'));

console.log('--- 6. dispatch feature-registered intent ---');
const refresh = JSON.parse((await callTool('ui:dispatch', { intent: 'refresh-build', args: { reason: 'test' }, timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('refresh-build status done', refresh.status === 'done');
check('feature handler ran with args', refresh.result?.feature_registered === true && refresh.result?.args?.reason === 'test');

console.log('--- 7. dispatch unknown intent ---');
const unk = JSON.parse((await callTool('ui:dispatch', { intent: 'never-registered-xyz', timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('unknown intent status error', unk.status === 'error');
check('error mentions unknown_intent', String(unk.error ?? '').includes('unknown_intent'));

console.log('--- 8. dispatch with no client_id available ---');
const noClient = await callTool('ui:dispatch', { intent: 'set_url', args: {} }, `?superuser=1&workspace=default`);
check('errors when no client_id', noClient.text.startsWith('client_id_required'));

console.log('--- 9. dispatch timeout when browser ignores ---');
await browser.stop();
const timeoutRes = JSON.parse((await callTool('ui:dispatch', { intent: 'set_url', args: { params: { tab: 'never' } }, timeout_ms: 1000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
check('timeout status', timeoutRes.status === 'timeout');
check('error mentions dispatch_timeout', String(timeoutRes.error ?? '').includes('dispatch_timeout'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
