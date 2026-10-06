/* Replay-only Node bootstrap. Its exact bytes run through --eval, so /proc
 * cmdline witnesses the recorder itself. Use the maintained plain-Node bundle
 * route: preloads, tsx and additional loaders are refused, never blessed. */
function startReplayRuntime(options) {
  const fs = require('node:fs');
  const Module = require('node:module');
  const { createHash } = require('node:crypto');
  const { resolve, join } = require('node:path');
  const { fileURLToPath, pathToFileURL } = require('node:url');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const originalReadFile = fs.readFileSync.bind(fs);
  let completeReadDepth = 0;
  const readFile = (...args) => {
    completeReadDepth++;
    try { return originalReadFile(...args); }
    finally { completeReadDepth--; }
  };
  const append = fs.appendFileSync.bind(fs);
  const identity = () => {
    const stat = readFile('/proc/self/stat', 'utf8');
    return `linux:${readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  };
  const processIdentity = identity();
  const target = join(options.directory, `${process.pid}.jsonl`);
  const emit = row => append(target, `${JSON.stringify({ schemaVersion: 'lsp-replay-runtime-receipt-v1',
    pid: process.pid, identity: processIdentity, runId: options.runId, ...row })}\n`);
  const startup = { kind: 'bootstrap', evalSha256: hash(process.execArgv[1] || ''),
    node: process.version, entry: resolve(options.entry), nodeOptions: process.env.NODE_OPTIONS || '',
    execArgv: process.execArgv };
  fs.writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
  emit(startup);
  if (startup.nodeOptions || process.execArgv.length !== 2 || process.execArgv[0] !== '--eval' ||
      typeof Module.registerHooks !== 'function') {
    emit({ kind: 'unknown', reason: 'unsupported-loader-or-preload' });
    throw new Error('replay-runtime requires plain Node with no preloads or other loaders');
  }
  const receipt = (kind, file, bytes, extra = {}) => {
    if (typeof file !== 'string' && !(file instanceof URL)) {
      emit({ kind: 'unknown', reason: 'unidentified-file-read' }); return;
    }
    const path = file instanceof URL ? fileURLToPath(file) : resolve(file);
    emit({ kind, path, sha256: hash(bytes), byteLength: Buffer.byteLength(bytes), ...extra });
  };
  Module.registerHooks({ load(url, context, nextLoad) {
    // The default ESM loader retained its original readFileSync before this
    // recorder patched fs. Its internal readSync is still a complete read:
    // nextLoad's returned source is witnessed below. No additional loader may
    // register, so this scope contains only Node's default loading boundary.
    let result;
    completeReadDepth++;
    try { result = nextLoad(url, context); }
    finally { completeReadDepth--; }
    if (url.startsWith('node:')) return result;
    if (!url.startsWith('file:') || result.source == null) {
      // CommonJS is witnessed at the actual compile boundary below.
      if (url.startsWith('file:') && ['commonjs', 'commonjs-typescript'].includes(result.format)) return result;
      emit({ kind: 'unknown', reason: `unsupported-load:${url}:${result.format}` });
      return result;
    }
    if (!['module', 'commonjs', 'json'].includes(result.format))
      emit({ kind: 'unknown', reason: `unsupported-format:${result.format}` });
    receipt('esm-load-return', new URL(url), typeof result.source === 'string' ? result.source : Buffer.from(result.source),
      { format: result.format });
    return result;
  } });
  const compile = Module.prototype._compile;
  const witnessedCompile = function (source, file) {
    receipt('commonjs-compile', file, source);
    return compile.call(this, source, file);
  };
  Module.prototype._compile = witnessedCompile;
  // JSON's CommonJS handler otherwise reads bytes outside the compile hook.
  Module._extensions['.json'] = (module, filename) => {
    const bytes = readFile(filename);
    receipt('json-load', filename, bytes);
    module.exports = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  const dlopen = process.dlopen;
  process.dlopen = function (module, filename, ...args) {
    emit({ kind: 'native-load', path: resolve(filename) });
    return dlopen.call(this, module, filename, ...args);
  };
  // Capture bytes returned to configuration/source consumers, rather than a
  // later disk hash. The receipt writer retains original fs functions.
  fs.readFileSync = function (file, ...args) {
    const bytes = readFile(file, ...args);
    receipt('file-read', file, bytes);
    return bytes;
  };
  const readAsync = fs.readFile;
  fs.readFile = function (file, ...args) {
    const callback = args.pop();
    return readAsync.call(this, file, ...args, (error, bytes) => {
      if (!error) receipt('file-read', file, bytes);
      callback(error, bytes);
    });
  };
  const readPromise = fs.promises.readFile;
  fs.promises.readFile = async function (file, ...args) {
    const bytes = await readPromise.call(this, file, ...args);
    receipt('file-read', file, bytes);
    return bytes;
  };
  // These readers do not expose a complete filename+byte population at this
  // boundary. Keep the run usable, but never qualify a closure that used them.
  for (const name of ['read', 'readSync', 'readv', 'readvSync', 'createReadStream']) {
    const original = fs[name];
    fs[name] = function (...args) {
      // Complete reads and the default ESM loader call exported readSync
      // internally; their returned bytes have a filename-bound receipt.
      if (!completeReadDepth) emit({ kind: 'unknown', reason: `unsupported-file-reader:${name}` });
      return original.apply(this, args);
    };
  }
  const openPromise = fs.promises.open;
  fs.promises.open = function (...args) {
    emit({ kind: 'unknown', reason: 'unsupported-file-reader:FileHandle' });
    return openPromise.apply(this, args);
  };
  // A later transform would invalidate this hook's final-return claim. Refuse
  // registration and publish an unknown receipt, including ESM named imports.
  const refuseLoader = () => {
    emit({ kind: 'unknown', reason: 'later-loader-registration' });
    throw new Error('replay-runtime refuses later loader registration');
  };
  Module.register = refuseLoader;
  Module.registerHooks = refuseLoader;
  Module.syncBuiltinESMExports();
  emit({ kind: 'ready', coverage: ['esm-load-return', 'commonjs-compile', 'json-load', 'file-read', 'native-load'] });
  process.argv = [process.execPath, resolve(options.entry), ...(options.args || [])];
  return import(pathToFileURL(resolve(options.entry)).href).catch(error => {
    emit({ kind: 'unknown', reason: `entry-failed:${String(error)}` });
    console.error(error);
    process.exitCode = 1;
  });
}
