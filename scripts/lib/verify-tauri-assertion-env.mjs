#!/usr/bin/env node
// Pure preflight for a file-backed verifier assertion. Read its declared
// assignments; never source the assertion before the owned Tauri rig exists.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [assertionPath, manifestPath] = process.argv.slice(2);
const fail = (reason) => {
  console.error(`VERIFY_TAURI_ASSERTION_ENV_INVALID ${reason}`);
  process.exit(2);
};

if (!assertionPath || !manifestPath) fail('assertion and manifest paths are required');
let source;
let manifest;
try {
  source = readFileSync(assertionPath, 'utf8');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('assertion or manifest could not be read');
}

const expected = manifest?.diagnosticEnv;
if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
    Object.keys(expected).length === 0) fail('manifest diagnosticEnv is missing');
if (typeof manifest.assertionSha256 !== 'string' ||
    createHash('sha256').update(source).digest('hex') !== manifest.assertionSha256) {
  fail('assertion bytes disagree with manifest assertionSha256');
}

const assignments = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=(.*)$/);
  if (!match) continue;
  const [, key, value] = match;
  if (assignments.has(key) && Object.hasOwn(expected, key)) fail(`${key} is assigned more than once`);
  assignments.set(key, value);
}

const visiting = new Set();
const resolved = new Map();
function resolve(key) {
  if (resolved.has(key)) return resolved.get(key);
  if (!assignments.has(key)) fail(`${key} is not assigned by the assertion`);
  if (visiting.has(key)) fail(`${key} has a circular assignment`);
  visiting.add(key);
  const raw = assignments.get(key);
  let value;
  if (/^'[^']*'$/.test(raw)) {
    value = raw.slice(1, -1);
  } else if (/^"[^"`\\]*"$/.test(raw)) {
    value = raw.slice(1, -1).replace(/\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g,
      (_, braced, plain) => resolve(braced ?? plain));
    if (value.includes('$')) fail(`${key} uses an unsupported shell expression`);
  } else if (/^[A-Za-z0-9_./:,%+@=-]*$/.test(raw)) {
    value = raw;
  } else {
    fail(`${key} uses an unsupported shell expression`);
  }
  visiting.delete(key);
  resolved.set(key, value);
  return value;
}

for (const [key, claimed] of Object.entries(expected)) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof claimed !== 'string') {
    fail('manifest diagnosticEnv must contain string environment entries');
  }
  if (resolve(key) !== claimed) fail(`${key} differs from manifest diagnosticEnv`);
}
if (Object.hasOwn(expected, 'GST_DEBUG_FILE') && manifest.diagnosticLogRoot &&
    dirname(expected.GST_DEBUG_FILE) !== manifest.diagnosticLogRoot) {
  fail('GST_DEBUG_FILE parent differs from manifest diagnosticLogRoot');
}
console.log(`VERIFY_TAURI_ASSERTION_ENV_OK ${Object.keys(expected).length} binding(s)`);
