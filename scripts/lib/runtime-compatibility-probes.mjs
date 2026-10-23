/** Isolated semantic operations for P-001; run with runtime-compatibility.mjs.
 * These seeds are not the complete application capability population. No probe
 * opens application data, inherits service credentials, or starts a bg owner.
 */
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';

export const NATIVE_EXPECTATIONS = Object.freeze({
  'sqlite-transaction-reopen': { rows: [{ value: 'committed' }], rolledBack: true },
  'sodium-secretbox-roundtrip': { plaintext: 'runtime compatibility', rejectsTampering: true },
  'sharp-png-roundtrip': { width: 1, height: 1, channels: 4, pixels: [17, 34, 51, 255] },
  'udx-loopback': { message: 'runtime compatibility' },
  'rocksdb-reopen': { value: 'committed' },
  'pty-input-exit': { echoed: true, exitCode: 0 },
});

// Required builtins occur in the pinned host/worker source census. These
// operations cover specific protocol contracts, not every use of each API.
export const RUNTIME_EXPECTATIONS = Object.freeze({
  'async-context-isolation': { contexts: ['first', 'second'], outside: null },
  'worker-transfer-exit': { values: [17, 34, 51], detached: true, exitCode: 0 },
  'process-ipc-exit': { reply: 42, exitCode: 0 },
  'http-stream-roundtrip': { status: 200, body: 'first\nsecond\n' },
  'http2-stream-roundtrip': { status: 200, body: 'first\nsecond\n' },
});

export async function performRuntimeCapability(id) {
  if (!Object.hasOwn(RUNTIME_EXPECTATIONS, id)) throw new Error(`Unknown runtime capability: ${id}`);
  if (id === 'async-context-isolation') {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { setImmediate } = await import('node:timers/promises');
    const context = new AsyncLocalStorage();
    try {
      const contexts = await Promise.all(['first', 'second'].map(value => context.run(value, async () => {
        await setImmediate();
        return context.getStore();
      })));
      return { contexts, outside: context.getStore() ?? null };
    } finally { context.disable(); }
  }
  if (id === 'worker-transfer-exit') {
    const { Worker } = await import('node:worker_threads');
    const directory = await mkdtemp(join(tmpdir(), 'papercusp-runtime-worker-'));
    let worker, hasExited = false;
    try {
      const script = join(directory, 'worker.mjs');
      await writeFile(script, `
        import { parentPort } from 'node:worker_threads';
        parentPort.once('message', buffer => {
          parentPort.postMessage([...new Uint8Array(buffer)]);
          parentPort.close();
        });
      `);
      // An explicit module file avoids inheriting the receipt runner's -e
      // input type, which changes the meaning of CommonJS eval workers.
      worker = new Worker(script, { execArgv: [] });
      worker.once('exit', () => { hasExited = true; });
      const reply = once(worker, 'message'), exited = once(worker, 'exit');
      const bytes = new Uint8Array([17, 34, 51]);
      worker.postMessage(bytes.buffer, [bytes.buffer]);
      const [[values], [exitCode]] = await Promise.all([reply, exited]);
      return { values, detached: bytes.byteLength === 0, exitCode };
    } finally {
      // Bun 1.3.14 does not settle terminate() after an observed exit. The
      // protocol already proved shutdown; only a still-running worker needs it.
      try { if (worker && !hasExited) await worker.terminate(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  if (id === 'process-ipc-exit') {
    const { fork } = await import('node:child_process');
    const directory = await mkdtemp(join(tmpdir(), 'papercusp-runtime-ipc-'));
    let child;
    try {
      const script = join(directory, 'child.cjs');
      await writeFile(script, "process.once('message', value => { process.send(value + 1, () => process.disconnect()); });\n");
      child = fork(script, [], { execPath: process.execPath, execArgv: [],
        env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const reply = once(child, 'message'), exited = once(child, 'close');
      child.send(41);
      const [value] = await reply, [exitCode] = await exited;
      return { reply: value, exitCode };
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (id === 'http2-stream-roundtrip') {
    const { createServer, connect } = await import('node:http2');
    const server = createServer();
    let client;
    server.on('stream', stream => {
      stream.respond({ ':status': 200 });
      stream.write('first\n');
      setImmediate(() => stream.end('second\n'));
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      client = connect(`http://127.0.0.1:${server.address().port}`);
      await once(client, 'connect');
      const request = client.request({ ':path': '/' });
      const response = once(request, 'response');
      request.end();
      const [headers] = await response;
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      return { status: headers[':status'], body };
    } finally {
      client?.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
  const { createServer, get } = await import('node:http');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('first\n');
    setImmediate(() => response.end('second\n'));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const response = await new Promise((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port: server.address().port, agent: false }, resolve);
      request.once('error', reject);
    });
    let body = '';
    for await (const chunk of response) body += chunk.toString();
    return { status: response.statusCode, body };
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export async function performNativeCapability(id, requireFrom) {
  if (!Object.hasOwn(NATIVE_EXPECTATIONS, id)) throw new Error(`Unknown native capability: ${id}`);
  if (!requireFrom || !isAbsolute(requireFrom)) throw new Error('Absolute candidate package manifest required');
  const require = createRequire(requireFrom);
  if (id === 'sodium-secretbox-roundtrip') {
    const sodium = require('sodium-native');
    const message = Buffer.from('runtime compatibility');
    const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES), nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
    sodium.randombytes_buf(key); sodium.randombytes_buf(nonce);
    const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES), plaintext = Buffer.alloc(message.length);
    try {
      sodium.crypto_secretbox_easy(ciphertext, message, nonce, key);
      if (!sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)) throw new Error('Secretbox roundtrip refused');
      ciphertext[0] ^= 1;
      return { plaintext: plaintext.toString(), rejectsTampering: !sodium.crypto_secretbox_open_easy(Buffer.alloc(message.length), ciphertext, nonce, key) };
    } finally { sodium.sodium_memzero(key); }
  }
  if (id === 'sharp-png-roundtrip') {
    const sharp = require('sharp');
    const png = await sharp(Buffer.from([17, 34, 51, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: info.channels, pixels: [...data] };
  }
  if (id === 'udx-loopback') {
    const UDX = require('udx-native'), udx = new UDX();
    const sender = udx.createSocket(), receiver = udx.createSocket();
    try {
      sender.bind(0, '127.0.0.1'); receiver.bind(0, '127.0.0.1');
      const received = once(receiver, 'message');
      await sender.send(Buffer.from('runtime compatibility'), receiver.address().port, '127.0.0.1');
      const [message] = await received;
      return { message: message.toString() };
    } finally { await Promise.all([sender.close(), receiver.close()]); }
  }
  if (id === 'pty-input-exit') {
    if (process.platform === 'win32') throw new Error('POSIX PTY probe does not cover Windows ConPTY');
    const pty = require('@lydell/node-pty');
    const terminal = pty.spawn('/bin/sh', ['-c', 'read value; printf "probe:%s\\n" "$value"'], {
      name: 'xterm', cols: 80, rows: 24, cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    let output = '';
    const data = terminal.onData(chunk => { output += chunk; });
    try {
      const exited = new Promise(resolve => terminal.onExit(resolve));
      terminal.write('runtime-compatibility\r');
      const { exitCode } = await exited;
      return { echoed: output.includes('probe:runtime-compatibility'), exitCode };
    } finally { data.dispose(); terminal.kill(); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'papercusp-runtime-probe-'));
  try {
    if (id === 'sqlite-transaction-reopen') {
      const Database = require('better-sqlite3'), path = join(directory, 'probe.sqlite');
      let db = new Database(path);
      let rolledBack = false;
      try {
        db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
        db.transaction(() => db.prepare('INSERT INTO probe VALUES (?)').run('committed'))();
        try {
          db.transaction(() => { db.prepare('INSERT INTO probe VALUES (?)').run('reverted'); throw new Error('planted rollback'); })();
        } catch (error) { if (error.message !== 'planted rollback') throw error; rolledBack = true; }
      } finally { db.close(); }
      db = new Database(path);
      try { return { rows: db.prepare('SELECT value FROM probe ORDER BY rowid').all(), rolledBack }; }
      finally { db.close(); }
    }
    const RocksDB = require('rocksdb-native'), path = join(directory, 'rocks');
    let db = new RocksDB(path);
    try { await db.ready(); await db.put('key', 'committed'); }
    finally { await db.close(); }
    db = new RocksDB(path);
    try { await db.ready(); return { value: (await db.get('key')).toString() }; }
    finally { await db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** The receipt runner invokes this inside the selected interpreter. */
export async function perform() {
  const id = process.env.PAPERCUSP_PROBE_CAPABILITY;
  return Object.hasOwn(RUNTIME_EXPECTATIONS, id) ? performRuntimeCapability(id)
    : performNativeCapability(id, process.env.PAPERCUSP_PROBE_REQUIRE_FROM);
}
