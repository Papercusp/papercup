/** Benchmark-only Node preload. Reuse Transformers/ORT's supported INFO
 * logging to retain the arena limit and successful extension sizes. This
 * changes diagnostics only; it constructs no session and changes no EP options.
 * The launch receipt must separately bind the configuration and dependency tree.
 */
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { readFileSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

const config = process.env.TSX_TSCONFIG_PATH;
if (!config || !isAbsolute(config) || !statSync(config).isFile()) {
  throw new Error('allocator logging requires the bound runtime configuration path');
}
const require = createRequire(config);
const entry = require.resolve('@huggingface/transformers');
const transformers = await import(pathToFileURL(entry).href);
if (transformers.LogLevel?.INFO !== 20 || !transformers.env?.backends?.onnx?.setLogLevel) {
  throw new Error('allocator logging requires the supported Transformers ONNX logging hook');
}
transformers.env.logLevel = transformers.LogLevel.INFO;
if (transformers.env.logLevel !== 20 || transformers.env.backends.onnx.logLevel !== 'info') {
  throw new Error('allocator logging was not applied to ONNX Runtime');
}
const entryBytes = readFileSync(entry);
const record = Buffer.from('PC_ORT_ALLOCATOR_LOGGING\t' + JSON.stringify({
  processId: process.pid, workerThreadId: threadId, transformersLogLevel: 20,
  onnxLogLevel: 'info', entry, bytes: entryBytes.length,
  sha256: createHash('sha256').update(entryBytes).digest('hex'),
  modelInferencePerformed: false, providerOptionsChanged: false,
}) + '\n');
if (writeSync(2, record) !== record.length) throw new Error('allocator logging receipt was not completely written');
