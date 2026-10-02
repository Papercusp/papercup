#!/usr/bin/env node
/**
 * PreToolUse (matcher "Bash|WebFetch") — a restricted session may not reach a
 * mail, chat, calendar or social provider with a native tool.
 *
 * Plan personal-data-reader-set-labels-2026-10-01, P-007, BAR R-11. Once an
 * agent has read a restricted personal document, every outbound send must go
 * through a gated verb (mail:send, chat:post, …) that checks the document's
 * reader set. capability:bash enforces that server-side; Claude Code's own
 * Bash and WebFetch never reach the operator, so this hook is their gate.
 *
 * Flow:
 *   1. PREFILTER (local, no I/O): does the command / URL name anything
 *      provider-shaped? The overwhelming majority of calls stop here, allowed.
 *   2. No PAPERCUSP_SID → allow. Not a psu session, so no disclosure can be
 *      attributed to it (D-004).
 *   3. Ask the operator: POST /api/agent-mcp/restricted-egress-check. The
 *      operator holds the authoritative target rules
 *      (personal-vault/provider-egress.mjs) and the disclosure ledger.
 *   4. verdict 'refuse' → DENY with the operator's reason. An unreachable or
 *      failing operator also DENIES: a provider-shaped target was named and
 *      nothing can show this session is unrestricted.
 *
 * The prefilter is a deliberately coarse copy of the operator's rule list (an
 * installed hook cannot import repository modules). It must match every rule's
 * sample: restricted-egress-guard.test.ts pins it to PROVIDER_EGRESS_RULES.
 */
import { operatorBase, sessionId } from '../inject/core.mjs';

const CHECK_TIMEOUT_MS = 4000;
const STDIN_TIMEOUT_MS = 2000;

/** Coarse provider-shaped tokens; a superset of provider-egress.mjs's rules. */
export const PROVIDER_PREFILTER = [
  /(?:gmail|people|calendar-json|oauth2)\.googleapis\.com/i,
  /www\.googleapis\.com\/(?:gmail|calendar|upload\/gmail)/i,
  /accounts\.google\.com\/o\/oauth2/i,
  /\b(?:imap|smtp|pop)\.gmail\.com/i,
  /graph\.microsoft\.com|outlook\.office(?:365)?\.com|login\.microsoftonline\.com/i,
  /slack\.com/i,
  /discord(?:app)?\.com/i,
  /api\.telegram\.org/i,
  /\b(?:api|upload)\.(?:twitter|x)\.com/i,
  /bsky\.(?:social|app|network)/i,
  /graph\.(?:facebook|instagram|whatsapp)\.com/i,
  /api\.linkedin\.com/i,
  /app-producer\.env/i,
  /\b(?:email|calendar)_app\b/,
  /:879[12]\b/,
];

/**
 * The text a tool call would act on.
 * @param {string} toolName
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {string[]}
 */
export function egressTexts(toolName, toolInput) {
  const input = toolInput ?? {};
  if (toolName === 'Bash' && typeof input.command === 'string') return [input.command];
  if (toolName === 'WebFetch' && typeof input.url === 'string') return [input.url];
  return [];
}

/** @param {readonly string[]} texts */
export function prefilterHits(texts) {
  return texts.some((text) => PROVIDER_PREFILTER.some((re) => re.test(text)));
}

/**
 * @param {{
 *   toolName: string,
 *   toolInput?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 * }} params
 * @returns {Promise<{ decision: 'allow' } | { decision: 'deny', reason: string }>}
 */
export async function decideEgress({ toolName, toolInput, env = process.env, fetchImpl = fetch }) {
  const texts = egressTexts(toolName, toolInput);
  if (!texts.length || !prefilterHits(texts)) return { decision: 'allow' };
  const owner = sessionId(env);
  if (!owner) return { decision: 'allow' };
  try {
    const res = await fetchImpl(`${operatorBase(env)}/api/agent-mcp/restricted-egress-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, tool: toolName, texts }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = res.ok ? await res.json() : null;
    if (!body || body.ok !== true) {
      return {
        decision: 'deny',
        reason:
          `This ${toolName} call names a mail, chat, calendar or social provider, and the operator could not ` +
          `confirm this session is unrestricted (HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}). ` +
          `Retry when the operator is reachable, or use the gated verb (mail:send, chat:post, …).`,
      };
    }
    if (body.verdict === 'refuse') {
      return { decision: 'deny', reason: String(body.reason || `${body.code ?? 'disclosure_egress_refused'}`) };
    }
    return { decision: 'allow' };
  } catch (error) {
    return {
      decision: 'deny',
      reason:
        `This ${toolName} call names a mail, chat, calendar or social provider, and the operator could not be ` +
        `reached to confirm this session is unrestricted (${error instanceof Error ? error.message : String(error)}). ` +
        `Retry when the operator is reachable, or use the gated verb (mail:send, chat:post, …).`,
    };
  }
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  const raw = await readStdin(STDIN_TIMEOUT_MS);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const result = await decideEgress({ toolName: String(payload.tool_name ?? ''), toolInput: payload.tool_input });
  if (result.decision !== 'deny') return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    }),
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('pretooluse-restricted-egress-guard.mjs');
if (invokedDirectly) {
  main().catch(() => {
    // A crashed guard must not wedge the session; the server-side checks
    // (capability:bash, the gated verbs) still hold.
  });
}
