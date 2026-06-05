/**
 * Wraps the omp (oh-my-pi) `config` subcommand so the operator UI can
 * read the full settings tree and persist changes.
 *
 * `omp config list` output is line-oriented:
 *
 *   Settings:
 *
 *   [section]
 *     key.path = value (type)
 *     ...
 *
 * Where `type` is one of: string, boolean, number, array, record, or an
 * enum literal `a|b|c`. For string/number scalars the value is rendered
 * inline; arrays/records are JSON-stringified on a single line.
 */

import { spawn } from 'node:child_process';

export type OmpConfigType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'array'
  | 'record'
  | { kind: 'enum'; choices: string[] };

export interface OmpConfigSetting {
  key: string;
  raw: string;          // verbatim value text from `omp config list`
  parsed: unknown;      // best-effort parsed value (boolean/number/JSON/string)
  type: OmpConfigType;
  isUnset: boolean;
}

export interface OmpConfigSection {
  name: string;
  settings: OmpConfigSetting[];
}

const TYPE_LITERALS = new Set(['string', 'boolean', 'number', 'array', 'record']);

function parseTypeAnnotation(rawType: string): OmpConfigType {
  if (TYPE_LITERALS.has(rawType)) return rawType as OmpConfigType;
  // Enum like "a|b|c"
  const choices = rawType.split('|').map((s) => s.trim()).filter(Boolean);
  if (choices.length > 1) return { kind: 'enum', choices };
  return 'string';
}

function parseValue(raw: string, type: OmpConfigType): { parsed: unknown; isUnset: boolean } {
  const isUnset = raw === '(not set)';
  if (isUnset) return { parsed: null, isUnset: true };
  if (type === 'boolean') return { parsed: raw === 'true', isUnset: false };
  if (type === 'number') {
    const n = Number(raw);
    return { parsed: Number.isFinite(n) ? n : raw, isUnset: false };
  }
  if (type === 'array' || type === 'record') {
    try { return { parsed: JSON.parse(raw), isUnset: false }; } catch { return { parsed: raw, isUnset: false }; }
  }
  return { parsed: raw, isUnset: false };
}

const LINE_RE = /^\s{2}([\w.-]+)\s+=\s+(.+?)\s+\((.+?)\)\s*$/;
const SECTION_RE = /^\[([^\]]+)\]\s*$/;

export function parseOmpConfigList(output: string): OmpConfigSection[] {
  const sections: OmpConfigSection[] = [];
  let current: OmpConfigSection | null = null;
  for (const line of output.split(/\r?\n/)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      current = { name: sec[1], settings: [] };
      sections.push(current);
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m || !current) continue;
    const [, key, rawValue, rawType] = m;
    const type = parseTypeAnnotation(rawType);
    const { parsed, isUnset } = parseValue(rawValue, type);
    current.settings.push({ key, raw: rawValue, parsed, type, isUnset });
  }
  return sections;
}

function execOmp(args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('omp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const t = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error(`omp ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export async function readOmpConfig(): Promise<OmpConfigSection[]> {
  const r = await execOmp(['config', 'list']);
  if (r.code !== 0) throw new Error(`omp config list failed (exit ${r.code}): ${r.stderr}`);
  return parseOmpConfigList(r.stdout);
}

/**
 * Set a single config key. Value is stringified to omp's expected wire format:
 * - boolean → 'true' | 'false'
 * - number  → String(n)
 * - array/record → JSON.stringify(v)
 * - string/enum → as-is
 *
 * Returns the new raw value omp echoed back, or throws.
 */
export async function setOmpConfig(key: string, value: unknown): Promise<{ raw: string }> {
  // Validate key shape — omp keys are dotted alphanumerics (no shell metas).
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid config key: ${key}`);
  let serialized: string;
  if (value === null || value === undefined) serialized = '';
  else if (typeof value === 'boolean') serialized = value ? 'true' : 'false';
  else if (typeof value === 'number') serialized = String(value);
  else if (typeof value === 'string') serialized = value;
  else serialized = JSON.stringify(value);

  const r = await execOmp(['config', 'set', key, serialized]);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 400);
    throw new Error(`omp config set ${key} failed: ${detail || `exit ${r.code}`}`);
  }
  return { raw: serialized };
}

/**
 * Reset a key back to its default by calling `omp config unset <key>` if
 * supported, falling back to `omp config set <key> ''` (omp treats empty
 * as "unset" for most string-typed scalars).
 */
export async function unsetOmpConfig(key: string): Promise<void> {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid config key: ${key}`);
  const r = await execOmp(['config', 'unset', key]);
  if (r.code !== 0) {
    // Older omp may not have `unset` — try `set <key> ''`.
    const r2 = await execOmp(['config', 'set', key, '']);
    if (r2.code !== 0) {
      const detail = (r2.stderr || r2.stdout).trim().slice(0, 400);
      throw new Error(`omp config unset ${key} failed: ${detail || `exit ${r2.code}`}`);
    }
  }
}
