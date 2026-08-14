#!/usr/bin/env node
/**
 * repair-codex-home-configs.mjs — WI-38706 one-time remediation.
 *
 * The session archiver was unlinking each per-session CODEX_HOME's shared
 * `config.toml` (it collected the home's directory-level state under whichever
 * thread ended first). Codex then re-created an 87-byte trust-only stub on the
 * next launch, so every `codex resume` in that home failed:
 *
 *   thread/resume failed: failed to load configuration:
 *   Model provider `papercusp-codex-gateway` not found (code -32600)
 *
 * The code fix (session-archive.ts + psu-launcher.mjs + /adv/sessions/ensure-codex-home)
 * stops it recurring and self-heals on the next resume; this restores the homes
 * that were already broken BEFORE that fix is deployed.
 *
 * A home is repaired only when its rollouts reference a provider its config does
 * not define, and only two ways:
 *   • RESTORE  — the pre-damage config recovered from the PG session archive
 *                (identical bytes, so the original account pin and the original
 *                `client=<sid>` survive). Preferred whenever available.
 *   • REBUILD  — for homes whose archived copy had already been overwritten by
 *                the 87-byte stub: a sibling's config as the template with THIS
 *                home's own identity substituted from its `.owner-sid`. The
 *                account pin is dropped (unpinned = the gateway auto-selects),
 *                which is what ensure-codex-home would write anyway.
 *
 * Idempotent, and refuses to touch a home that is already healthy.
 * Usage:  node scripts/repair-codex-home-configs.mjs [--write]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOMES = join(homedir(), '.papercusp', 'su-codex-homes');
const RESCUE = join(homedir(), '.papercusp', 'codex-config-rescue-2026-08-14');
const PROVIDER = 'papercusp-codex-gateway';
const WRITE = process.argv.includes('--write');

/** The provider a rollout is bound to (`session_meta.model_provider`). */
function rolloutProvider(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4096);
    const line = head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n'));
    return JSON.parse(line)?.payload?.model_provider ?? null;
  } catch { return null; }
}

function rollouts(home) {
  const out = [];
  const root = join(home, 'sessions');
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Biggest rescued copy for this home (the archive keyed several session ids). */
function rescuedFor(dirName) {
  let best = null;
  for (const f of readdirSync(RESCUE)) {
    if (!f.startsWith(`${dirName}__`)) continue;
    const p = join(RESCUE, f);
    const size = statSync(p).size;
    if (!best || size > best.size) best = { path: p, size };
  }
  return best;
}

/** A full sibling config to use as a REBUILD template: has the MCP block and the
 *  provider table, so only the identity needs substituting. */
function templateConfig() {
  let best = null;
  for (const f of readdirSync(RESCUE)) {
    const p = join(RESCUE, f);
    const text = readFileSync(p, 'utf8');
    if (!text.includes('[mcp_servers.papercusp-su]')) continue;
    if (!text.includes(`[model_providers.${PROVIDER}]`)) continue;
    const size = statSync(p).size;
    if (!best || size > best.size) best = { path: p, text, size };
  }
  return best;
}

function rebuildFrom(templateText, sid) {
  return templateText
    // This home's own coordination identity — the ONLY per-session token in the file.
    .replace(/client=su-[0-9a-f-]+/g, `client=${sid}`)
    // Drop the template's account pin: it names a DIFFERENT session's account.
    // Header omitted (never emitted empty) ⇒ the gateway auto-selects, which is
    // exactly what ensure-codex-home writes for an unpinned repair.
    .replace(/^http_headers = \{ "x-papercusp-account".*\n/m, '');
}

const template = templateConfig();
const report = [];
for (const dirName of readdirSync(HOMES).sort()) {
  if (!dirName.startsWith('session-')) continue;
  const home = join(HOMES, dirName);
  if (!statSync(home).isDirectory()) continue;

  const providers = new Set(rollouts(home).map(rolloutProvider).filter(Boolean));
  if (!providers.has(PROVIDER)) continue; // nothing here needs the gateway table

  const cfgPath = join(home, 'config.toml');
  const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
  if (cfg?.includes(`[model_providers.${PROVIDER}]`) && cfg.includes('[mcp_servers.papercusp-su]')) continue; // healthy

  const rescued = rescuedFor(dirName);
  const usable = rescued && readFileSync(rescued.path, 'utf8').includes('[mcp_servers.papercusp-su]')
    ? readFileSync(rescued.path, 'utf8')
    : null;

  let action, text;
  if (usable) {
    action = 'RESTORE';
    text = usable;
  } else {
    const sid = existsSync(join(home, '.owner-sid')) ? readFileSync(join(home, '.owner-sid'), 'utf8').trim() : null;
    if (!sid || !template) { report.push({ dirName, action: 'SKIP (no rescue, no .owner-sid)' }); continue; }
    action = 'REBUILD';
    text = rebuildFrom(template.text, sid);
  }
  if (WRITE) writeFileSync(cfgPath, text, { mode: 0o600 });
  report.push({ dirName, action, bytes: text.length, was: cfg === null ? 'missing' : `${cfg.length}B stub` });
}

for (const r of report) console.log(`${r.action.padEnd(8)} ${r.dirName}  ${r.was ?? ''} -> ${r.bytes ?? '-'}B`);
console.log(`\n${WRITE ? 'WROTE' : 'DRY RUN'}: ${report.length} home(s). Template: ${template ? template.path.split('/').pop() : 'none'}`);
