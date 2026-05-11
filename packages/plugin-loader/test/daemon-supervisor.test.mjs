import { startDaemonPlugin } from '../src/daemon/index.ts';
import { resolve } from 'node:path';

// pythonista smoke now lives in the libs/papercusp submodule (papercup PR #61).
// Path: <repo>/libs/papercusp/plugins/pythonista/daemon.py
const cwd = resolve(import.meta.dirname, '../../../libs/papercusp/plugins/pythonista');
const handle = await startDaemonPlugin({
  pluginName: 'pythonista', cmd: ['/usr/bin/python3', resolve(cwd,'daemon.py')], cwd,
  restart:{policy:'never'}, healthIntervalMs:0,
});
const enc = new TextEncoder();
const r1 = await handle.callAction('run-script', enc.encode('1+1'));
console.log('1+1 →', r1.ok ? new TextDecoder().decode(r1.payload) : r1.error);
const r2 = await handle.callAction('does-not-exist', enc.encode(''));
console.log('not-found tag:', r2.ok ? 'OK??' : r2.error.tag);
console.log('not-found msg:', r2.ok ? '' : r2.error.message);
const r3 = await handle.callAction('run-script', enc.encode('1/0'));
console.log('1/0 tag:', r3.ok ? 'OK??' : r3.error.tag);
await handle.shutdown();
await new Promise(r=>setTimeout(r,200));
console.log('PASS');
process.exit(0);
