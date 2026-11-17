/**
 * INJECTION TRANSPORT — the one place that talks to the operator.
 *
 * Plan: codex-context-injection-parity-2026-08-09, D-001 (FROZEN, shared
 * verbatim with omp-context-injection-parity-2026-08-09).
 *
 * Everything client-specific lives in `adapters/*.mjs`. Everything about
 * WHEN/HOW LONG/WHETHER-AT-ALL to call lives here, so a fix to the transport is
 * a fix for every client at once — the property that made three copied shell
 * scripts the wrong answer.
 *
 * ── FAIL-SILENT IS THE CONTRACT, NOT AN ERROR-HANDLING STYLE (invariant 1) ──
 * Every failure path returns null and every caller injects nothing. A context
 * hook that raises an error can wedge the client's turn — and it would do so at
 * the exact moment the operator is already unhealthy, i.e. it converts a
 * degraded backend into a broken agent. The bare `|| exit 0` and blanket
 * `except:` in the shell scripts this replaces were this invariant, not
 * sloppiness (D-001 says so explicitly). The tests assert EXIT 0 AND EMPTY
 * STDOUT together, because that pair is the actual contract.
 */

import { PORTS, killSwitchState, specFor } from './ports.mjs';
import { isAbsolute, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseShellCommand } from './shell-quote.mjs';
import { codeIntelDelivery } from './delivery-ledger.mjs';
import { extractRecallSignals } from './recall-query.mjs';

/**
 * @typedef {import('./ports.mjs').InjectionPort} InjectionPort
 * @typedef {'claude' | 'codex' | 'omp'} InjectionClient
 */

/**
 * @typedef {object} InjectionRequest
 * @property {string} owner
 * @property {string} workspace
 * @property {string} harness
 * @property {string} cwd
 * @property {InjectionClient} client
 * @property {string} [prompt]
 * @property {Array<{ tool: string, toolInput: string, toolResponse: string }>} [toolCalls]
 * @property {boolean} [memoryEnabled]
 * @property {string} [detectorSessionKey] private failure-loop detector key
 * @property {string | null} [confirmedDelivery] turn-start ACK-ON-PROOF token (delivery-ledger.mjs)
 * @property {object[]} [confirmedFactBodies] private manifests from this token's immutable stdout receipt
 * @property {object[]} [confirmedMemoryDeliveries] exact memory/corpus fragments from recent stdout receipts
 * @property {string} [turnStartRequestId] opaque per-request receipt key
 * @property {string} [guardRequestId] opaque correlation key for one authority lookup
 */

/** Loopback operator. */
export function operatorBase(env = process.env) {
  return (env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\/+$/, '');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PLAN_TEXT_REPAIR_KEYS = new Set([
  'slug', 'harness', 'old_string', 'new_string', 'replace_all', 'allowDecisionDrop', 'expectedHash', 'rationale',
]);
const PLAN_AUDIT_BASE_KEYS = new Set(['slug', 'harness', 'phase', 'dryRun']);
const PLAN_AUDIT_ACTIVATION_KEYS = new Set([
  'classRef', 'sourceRanges', 'mappings', 'itemProvenance', 'repairedOmissions',
  'rejectedOrSuperseded', 'unresolvedBlockers', 'summary',
]);
const PLAN_AUDIT_PRESTART_PHASES = new Set(['activation', 'discovery', 'shaping']);
const PLAN_AUDIT_CLASS_REFS = new Set([
  'plan-class-feature-ship', 'plan-class-bugfix', 'plan-class-migration',
  'plan-class-investigation', 'plan-class-general',
]);

/**
 * The operators to try, in order: the pin, then — for a LOOPBACK pin only — the
 * local MCP proxy (PAPERCUSP_MCP_PROXY_PORT, default 9071), which forwards to the
 * :3070 operator and bridges its restarts.
 *
 * WI-10005007: a session launched from a staging console inherits
 * PAPERCUSP_OPERATOR_URL=http://localhost:3170 and keeps it across every
 * carry-respawn. Staging restarts many times a day, and while it is down this
 * hook got nothing back, so the turn carried no CTRL, orientation or memory. Worse,
 * turn-start ACK-ON-PROOF (delivery-ledger.mjs) can only acknowledge a delivery the
 * hook actually printed, so a session whose turns keep landing in staging's down
 * windows sees its in-place identity activation sit at 'prepared' for hours. The
 * provenance hook already falls back this way (EI-24091823697677465,
 * userpromptsubmit-provenance.sh `_mcp_candidate_bases`); this is the same rule for
 * the injection transport, so the two cannot disagree about where a turn goes.
 *
 * A non-loopback pin names a different operator: writing to the local one instead
 * would be wrong, so it gets no fallback.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function operatorBases(env = process.env) {
  const pinned = operatorBase(env);
  let url;
  try {
    url = new URL(pinned);
  } catch {
    return [pinned];
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return [pinned];
  const raw = String(env.PAPERCUSP_MCP_PROXY_PORT ?? '').trim();
  const proxyPort = /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535 ? String(Number(raw)) : '9071';
  const pinnedPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  return pinnedPort === proxyPort ? [pinned] : [pinned, `http://127.0.0.1:${proxyPort}`];
}

/** The native tool guard is an idempotent read; reserve time for each loopback
 * route so a stalled first origin cannot consume the hard wall before its
 * configured fallback is tried. */
function preToolGuardRoute(env = process.env) {
  const bases = operatorBases(env);
  let pinned;
  try { pinned = new URL(operatorBase(env)); }
  catch { return { bases, splitWall: false }; }
  if (!LOOPBACK_HOSTS.has(pinned.hostname.toLowerCase())) return { bases, splitWall: false };
  const raw = String(env.PAPERCUSP_MCP_PROXY_PORT ?? '').trim();
  const proxyPort = /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535 ? String(Number(raw)) : '9071';
  const pinnedPort = pinned.port || (pinned.protocol === 'https:' ? '443' : '80');
  const rawStagingPort = String(env.PAPERCUSP_MCP_STAGING_PROXY_PORT ?? '').trim();
  const configuredStagingPort = /^\d+$/.test(rawStagingPort) &&
    Number(rawStagingPort) > 0 && Number(rawStagingPort) <= 65535
    ? String(Number(rawStagingPort)) : null;
  const stagingProxyPort = configuredStagingPort ?? '9171';
  const proxyTargetPort = String(env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? '').trim();
  const stagingRuntime =
    pinnedPort === '3170' ||
    pinnedPort === stagingProxyPort ||
    (pinnedPort === proxyPort && configuredStagingPort !== null &&
      proxyTargetPort !== '3271') ||
    (pinnedPort === proxyPort && proxyTargetPort === '3170');
  if (stagingRuntime) {
    // The staging API exposes a same-build proxy (:9171 → :3170). A legacy
    // launcher may still pin :9071, whose default is green main; the explicit
    // staging marker must override that route. :3170 is the only safe fallback.
    const directStagingBase = pinnedPort === '3170'
      ? (bases.find(base => {
        try { return new URL(base).port === '3170'; } catch { return false; }
      }) ?? operatorBase(env))
      : 'http://127.0.0.1:3170';
    const stagingProxyEnabled =
      env.PAPERCUSP_MCP_PROXY !== '0' && env.PAPERCUSP_MCP_STAGING_PROXY !== '0';
    if (!stagingProxyEnabled || stagingProxyPort === '3170')
      return { bases: [directStagingBase], splitWall: false };
    return {
      bases: ['http://127.0.0.1:' + stagingProxyPort, directStagingBase],
      splitWall: true,
    };
  }
  // An HTTP tool-guard request carries no MCP build selector. The proxy's
  // default target is green main, so falling back from an explicit current-
  // build pin (for example :3170 staging) could turn a staging outage into an
  // empty, permissive verdict from older main code. Keep build-specific pins
  // fail-closed; only the :3070/main and :9071/default-proxy pair may cross-fallback.
  if (pinnedPort !== '3070' && pinnedPort !== proxyPort)
    return { bases: [bases[0] ?? operatorBase(env)], splitWall: false };
  if (bases.length > 1) return { bases, splitWall: true };
  if (proxyPort !== '9071' || pinnedPort !== proxyPort) return { bases, splitWall: false };
  return { bases: [...bases, 'http://localhost:3070'], splitWall: true };
}

/**
 * The session id IS the gate: no PAPERCUSP_SID means this is not a psu session,
 * so there is no session to inject into and nothing to look up (invariant 3).
 * Checked before anything else — cheapest possible exit, and the common case
 * for a developer running the client by hand.
 * @returns {string | null}
 */
export function sessionId(env = process.env) {
  const sid = env.PAPERCUSP_SID;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

/** Shared CTRL parser for the owner fence and emission receipt metadata.
 * @param {string} text
 */
function controlTransitionBlock(text) {
  // The server renders CTRL as one marker + one JSON line, then separates the
  // following orientation/memory blocks with a blank line. Keep this parser
  // deliberately narrow: an unrecognisable first block is not control we can
  // safely trust, so it is dropped rather than guessed at.
  const match = /^⟦CTRL:(?:transition|full-resync)⟧[ \t]*([^\r\n]*)(?:\r?\n\r?\n|$)/.exec(text);
  if (!match) return null;

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    payload = null;
  }
  return { header: match[0], payload };
}

/**
 * Keep a returned CTRL block bound to the session that requested it.
 *
 * The operator already enforces this at the durable-anchor read, but the hook
 * is the last boundary before text reaches a client. A stale operator response
 * (or an older server that does not stamp `targetOwnerId`) must not be able to
 * change a successor's mode, loop, route, or scope. CTRL is the first block in
 * the turn-start response, followed by ordinary orientation/memory context;
 * reject only that block so useful non-control context can still be delivered.
 *
 * @param {unknown} text
 * @param {string} owner
 * @returns {string | null}
 */
export function fenceControlTransition(text, owner) {
  if (typeof text !== 'string' || !text) return null;
  if (!text.startsWith('⟦CTRL:')) return text;
  const block = controlTransitionBlock(text);
  if (!block) return null;
  if (block.payload && typeof block.payload === 'object' && block.payload.targetOwnerId === owner) return text;

  const remainder = text.slice(block.header.length);
  return remainder || null;
}

/**
 * Build the request envelope shared by every client and both ports.
 *
 * ⚠ `cwd` is load-bearing, not decoration (EI-18893248175645463).
 * PAPERCUSP_HARNESS_SLUG is only exported for harness-scoped spawns, so an
 * operator/superuser-scope session never has one — and without a fallback its
 * harness AND hive memory pools were empty for the session's ENTIRE lifetime.
 * Sending cwd lets the server run its own env -> marker-file -> meta-repo
 * detection chain (detect-harness-slug.ts) instead of giving up. Both claude
 * hooks were fixed to send it; anything that drops it re-opens that bug.
 *
 * @param {{ port: InjectionPort, client: InjectionClient, owner: string, cwd?: string, env?: NodeJS.ProcessEnv }} args
 * @returns {InjectionRequest}
 */
export function baseRequest({ port, client, owner, cwd, env = process.env }) {
  /** @type {InjectionRequest} */
  const req = {
    owner,
    client,
    workspace: env.PAPERCUSP_WORKSPACE || '',
    harness: env.PAPERCUSP_HARNESS_SLUG || '',
    cwd: cwd || process.cwd(),
  };
  // See ports.mjs: 'degrade' means the request still goes, memory suppressed.
  const { off, mode } = killSwitchState(port, env);
  if (port === 'turn-start') req.memoryEnabled = !(off && mode === 'degrade');
  return req;
}

/**
 * POST an injection request and return the text to inject.
 *
 * ⚠ NEVER route the loopback operator through an egress proxy. A configured
 * http(s)_proxy 502s the local call, which presents as "injection silently
 * stopped working" on exactly the boxes that have a proxy set. Node's fetch
 * only consults a proxy when one is installed explicitly, so the guard is to
 * pass no agent — documented here because the shell version needed an explicit
 * ProxyHandler({}) and the reason is not obvious from the code.
 *
 * @param {InjectionPort} port
 * @param {InjectionRequest} body
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: () => number,
 *   onTurnStartOutcome?: (outcome: object) => void,
 *   onHookOutcome?: (outcome: object) => void }} [opts]
 * @returns {Promise<{ text: string, deliveryToken: string | null, packingReceipt?: { attemptId: string, sha256: string }, factBodyOffers?: object[], memoryFragmentOffers?: object[] } | null>} the text
 *   to inject plus the turn-start orientation delivery token (delivery-ledger.mjs),
 *   or null to inject nothing
 */
export async function postInjection(port, body, opts = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = opts;
  const spec = specFor(port);
  if (!spec) return null;
  const requestId = port === 'turn-start' && typeof body.turnStartRequestId === 'string' &&
    /^[A-Za-z0-9_-]{1,80}$/.test(body.turnStartRequestId) ? body.turnStartRequestId : null;
  // One id spans every attempted origin and the eventual timeout diagnostic.
  // Generate it here so callers cannot smuggle tool content into server logs.
  const guardRequestId = port === 'pre-tool' ? randomUUID() : null;
  let outcomeReported = false;
  const reportTurnStartOutcome = (hookOutcome, payload = null) => {
    if (port !== 'turn-start' || !requestId || outcomeReported) return;
    outcomeReported = true;
    const responseOutcome = payload && typeof payload === 'object' ? payload.turnStartOutcome : null;
    const validOutcome = responseOutcome && typeof responseOutcome === 'object' ? responseOutcome : null;
    const serverOutcome = hookOutcome !== 'response-received' ? 'unavailable'
      : !validOutcome ? 'missing'
        : validOutcome.requestId === requestId ? 'matched' : 'mismatched';
    const matches = serverOutcome === 'matched';
    const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
    try {
      opts.onTurnStartOutcome?.({
        requestId,
        client: body.client,
        hookOutcome,
        serverOutcome,
        ambientGate: matches
          ? oneOf(validOutcome.ambientGate, ['allowed', 'denied', 'error', 'unknown'], 'unknown')
          : 'unknown',
        loopFire: matches && typeof validOutcome.loopFire === 'boolean' ? validOutcome.loopFire : null,
        loopMarkerAppend: matches
          ? oneOf(validOutcome.loopMarkerAppend, ['appended', 'failed', 'not-applicable', 'pending', 'unknown'], 'unknown')
          : 'unknown',
        // Keep failure diagnostics on the existing per-request receipt even
        // when optional hook tracing is off. Never persist request/error text.
        transport: {
          phase: transportPhase ?? 'not-started',
          operatorOrigin: attemptedOperatorOrigin,
          timeoutMs: spec.timeoutMs,
          elapsedMs: Math.max(0, now() - startedAt),
          preFetchMs: fetchStartedAt === null ? null : Math.max(0, fetchStartedAt - startedAt),
          fetchMs: fetchStartedAt === null ? null : Math.max(0, (headersReceivedAt ?? now()) - fetchStartedAt),
          responseStatus,
          proxyTraceId,
          upstreamOrigin,
          headersElapsedMs: headersReceivedAt === null ? null : Math.max(0, headersReceivedAt - startedAt),
          responseBodyMs: bodyStartedAt === null ? null : Math.max(0, (bodyFinishedAt ?? now()) - bodyStartedAt),
        },
      });
    } catch { /* optional per-request evidence never changes hook delivery */ }
  };
  const startedAt = now();
  // WI-6554700010042393: which branch of this exchange produced
  // the answer. Every failure below returns the same empty finish(), so without
  // this an abort during local collection is indistinguishable from an empty
  // server answer. The mutation guard also uses the actual response receipt;
  // an empty successful verdict must not be mistaken for unavailable authority.
  // Reported once; a throwing callback never changes transport delivery.
  let collectMs = null;
  let attemptedOperatorOrigin = null;
  let fetchStartedAt = null;
  let headersReceivedAt = null;
  let bodyStartedAt = null;
  let bodyFinishedAt = null;
  let transportPhase = null;
  let responseStatus = null;
  let proxyTraceId = null;
  let upstreamOrigin = null;
  const collectErrors = [];
  const guardAttempts = [];
  let hookOutcomeReported = false;
  const reportHookOutcome = (stage, extra = {}) => {
    if (hookOutcomeReported || typeof opts.onHookOutcome !== 'function') return;
    hookOutcomeReported = true;
    try {
      const finishedAt = now();
      opts.onHookOutcome({
        port, stage, timeoutMs: spec.timeoutMs, elapsedMs: Math.max(0, finishedAt - startedAt), collectMs,
        ...(fetchStartedAt !== null ? {
          transportPhase,
          fetchMs: Math.max(0, (headersReceivedAt ?? finishedAt) - fetchStartedAt),
          headersElapsedMs: headersReceivedAt === null ? null : Math.max(0, headersReceivedAt - startedAt),
          responseBodyMs: bodyStartedAt === null ? null : Math.max(0, (bodyFinishedAt ?? finishedAt) - bodyStartedAt),
        } : {}),
        ...(guardRequestId ? { guardRequestId } : {}),
        ...(attemptedOperatorOrigin ? { operatorOrigin: attemptedOperatorOrigin } : {}),
        ...(guardAttempts.length ? { guardAttempts: guardAttempts.map(attempt => ({ ...attempt })) } : {}),
        ...(collectErrors.length ? { collectErrors } : {}), ...extra,
      });
    } catch { /* diagnostic only */ }
  };

  const { off, mode } = killSwitchState(port, env);
  if (off && mode === 'suppress') {
    reportTurnStartOutcome('suppressed');
    reportHookOutcome('suppressed');
    return null;
  }

  if (port === 'turn-start' || port === 'compaction') codeIntelDelivery(body.owner, env, () => null, port);
  const finish = (text = '', deliveryToken = null, factBodyOffers = [], memoryFragmentOffers = [], packingReceipt = undefined) => {
    const packing = packingReceipt ? { packingReceipt } : {};
    if (port !== 'mid-turn') return text.trim() ? { text, deliveryToken,
      ...packing,
      ...(factBodyOffers.length ? { factBodyOffers } : {}),
      ...(memoryFragmentOffers.length ? { memoryFragmentOffers } : {}) } : null;
    const merged = mergeCodeIntel(body, text, env);
    return merged?.trim() ? { text: merged, deliveryToken,
      ...packing,
      ...(memoryFragmentOffers.length ? { memoryFragmentOffers } : {}) } : null;
  };

  // AbortSignal.timeout is the hard wall (invariant 2). It bounds the whole
  // exchange including body read, which a per-socket timeout would not.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    // Collect locally, where the edited file and its owning repo exist. Never run
    // the parser/compiler on the shared operator's 250ms snapshot push path.
    // A collector that rejects outright (e.g. its helper module is missing from an
    // installed hook dir) costs only its own enrichment, never the server's answer.
    if (port === 'mid-turn') {
      const collectStartedAt = now();
      const settled = await Promise.allSettled([collectInterfaceEdits(body, undefined, env), collectAntipatternEdits(body), collectCloneEdits(body)]);
      collectMs = Math.max(0, now() - collectStartedAt);
      for (const result of settled) {
        if (result.status === 'rejected') collectErrors.push(String(result.reason?.message ?? result.reason).slice(0, 300));
      }
    }
    if (controller.signal.aborted || typeof fetchImpl !== 'function') {
      reportTurnStartOutcome('request-failed');
      reportHookOutcome(controller.signal.aborted ? 'wall-before-fetch' : 'no-fetch');
      return finish();
    }
    // wallMs: what is LEFT of this hook's own wall when the request leaves, so the
    // operator spends only that (the Jev memory filter's wait, WI-10004485). The
    // wall timer above started before local collection, which measured 0.75-0.8 s
    // cold on the mid-turn port (code-intel-delivery-and-outcomes-2026-10-26#P-002).
    // Sending the full spec value told the server it had time the hook had already
    // spent, so a slow server answer was aborted here and nothing was injected.
    // Derived from the spec, never a second copy of the number on the server.
    const wallMs = Math.max(1, spec.timeoutMs - Math.max(0, now() - startedAt));
    const payloadBody = JSON.stringify({ ...body, wallMs, ...(guardRequestId ? { guardRequestId } : {}) });
    let res = null;
    fetchStartedAt = now();
    transportPhase = 'waiting-for-headers';
    // Context ports retain serial fallback: a delayed answer may acknowledge
    // delivery on another host. Guard lookups are idempotent reads. Start their
    // fallback at half-wall without cancelling a primary that can still answer
    // inside the absolute wall. The first HTTP response wins, including errors;
    // a refusal must never trigger a search for a more permissive response.
    const guardRoute = port === 'pre-tool' ? preToolGuardRoute(env) : null;
    const bases = guardRoute?.bases ?? operatorBases(env);
    const guardRequests = [];
    const fetchOrigin = async base => {
      const attemptStartedAt = port === 'pre-tool' ? now() : null;
      const attemptController = port === 'pre-tool' ? new AbortController() : null;
      const signal = attemptController
        ? AbortSignal.any([controller.signal, attemptController.signal]) : controller.signal;
      signal.throwIfAborted();
      const origin = new URL(base).origin;
      let attempt = null;
      if (attemptStartedAt !== null) {
        attempt = { origin, startElapsedMs: Math.max(0, attemptStartedAt - startedAt),
          headerBudgetMs: Math.max(1, spec.timeoutMs - Math.max(0, attemptStartedAt - startedAt)),
          headerWaitMs: null, outcome: 'request-failed', status: null };
        guardAttempts.push(attempt);
        guardRequests.push({ controller: attemptController, attempt, startedAt: attemptStartedAt });
      }
      attemptedOperatorOrigin = origin;
      try {
        const response = await fetchImpl(base + spec.endpoint, {
          method: 'POST',
          // The route stack sees headers before the handler reads the body.
          // Reuse this lookup's opaque id to attribute pre-handler delays too.
          headers: { 'Content-Type': 'application/json',
            ...(guardRequestId ? { 'X-Papercusp-Guard-Request-Id': guardRequestId } : {}),
          },
          body: payloadBody,
          signal,
        });
        signal.throwIfAborted();
        if (attempt) {
          attempt.outcome = 'headers-received';
          attempt.status = Number.isInteger(response.status) ? response.status : null;
        }
        return { response, origin, headersAt: now(), controller: attemptController };
      } catch (err) {
        if (attempt && attempt.outcome !== 'superseded')
          attempt.outcome = controller.signal.aborted ? 'wall-expired' : 'request-failed';
        throw err;
      } finally {
        if (attempt && attempt.headerWaitMs === null)
          attempt.headerWaitMs = Math.max(0, now() - attemptStartedAt);
      }
    };
    let selected = null;
    let fallbackTimer = null;
    try {
      if (guardRoute?.splitWall) {
        const primary = fetchOrigin(bases[0]);
        const first = await Promise.race([
          primary.then(value => ({ value }), () => null),
          new Promise(resolve => {
            const remaining = Math.max(1, spec.timeoutMs - Math.max(0, now() - startedAt));
            fallbackTimer = setTimeout(() => resolve(null), Math.max(1, Math.floor(remaining / 2)));
          }),
        ]);
        clearTimeout(fallbackTimer);
        if (first) selected = first.value;
        else selected = await Promise.any([primary, fetchOrigin(bases[1])]);
      } else {
        for (const base of bases) {
          try { selected = await fetchOrigin(base); break; }
          catch (err) { if (controller.signal.aborted) throw err; }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) throw err;
    } finally {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      for (const pending of guardRequests) {
        if (pending.controller === selected?.controller) continue;
        // Freeze diagnostics before abort listeners settle so the emitted
        // receipt includes cancellation even when a losing fetch is pending.
        if (pending.attempt.headerWaitMs === null) {
          pending.attempt.headerWaitMs = Math.max(0, now() - pending.startedAt);
          pending.attempt.outcome = controller.signal.aborted ? 'wall-expired' : 'superseded';
        }
        pending.controller.abort();
      }
    }
    if (selected) {
      res = selected.response;
      attemptedOperatorOrigin = selected.origin;
      headersReceivedAt = selected.headersAt;
      responseStatus = res.status;
      transportPhase = 'headers-received';
      if (port === 'turn-start') {
        proxyTraceId = res.headers?.get('x-papercusp-mcp-trace-id') ?? null;
        upstreamOrigin = res.headers?.get('x-papercusp-mcp-upstream-origin') ?? null;
      }
    }
    if (!res || !res.ok) {
      reportTurnStartOutcome(res ? 'http-error' : 'request-failed');
      reportHookOutcome(res ? 'http-error' : 'unreachable', res ? { status: res.status } : {});
      return finish();
    }
    // The hard wall covers both phases. Preserve the distinction when a proxy
    // completed its response but this client still timed out reading/decoding it.
    bodyStartedAt = now();
    transportPhase = 'reading-body';
    const payload = await res.json();
    bodyFinishedAt = now();
    transportPhase = 'body-received';
    if (!payload || typeof payload !== 'object') {
      reportTurnStartOutcome('invalid-response');
      reportHookOutcome('invalid-response');
      return finish();
    }
    reportTurnStartOutcome('response-received', payload);
    const { text, deliveryToken, factBodyOffers, memoryFragmentOffers, packingReceipt } = payload;
    reportHookOutcome('response-received', { textChars: typeof text === 'string' ? text.length : 0 });
    return finish(typeof text === 'string' ? text : '', typeof deliveryToken === 'string' && deliveryToken ? deliveryToken : null,
      Array.isArray(factBodyOffers) ? factBodyOffers : [],
      Array.isArray(memoryFragmentOffers) ? memoryFragmentOffers : [], packingReceipt);
  } catch (err) {
    // Timeout, connection refused, malformed JSON, operator restarting mid-call.
    // All of it is "inject nothing" — never an error the turn can see.
    reportTurnStartOutcome('request-failed');
    reportHookOutcome(controller.signal.aborted ? 'wall-during-fetch' : 'request-failed',
      { error: String(err?.message ?? err).slice(0, 300) });
    return finish();
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve native relative edit paths from the requesting session, including a
 * hook installed outside that checkout. Keep one bounded collection per batch. */
export async function collectInterfaceEdits(body, collect = async path => {
  const { consequenceFor } = await import('../cc/posttooluse-required-field-strand-nudge.mjs');
  return consequenceFor(path, { includeSourceChanges: true });
}, env = process.env) {
  let remaining = 2;
  const seen = new Set();
  const measured = [];
  for (const call of body.toolCalls ?? []) {
    for (const path of call.editedPaths ?? (call.editedPath ? [call.editedPath] : [])) {
      if (typeof path !== 'string') continue;
      const abs = resolve(body.cwd || process.cwd(), path);
      if (seen.has(abs) || remaining <= 0) continue;
      seen.add(abs); remaining--;
      try {
        const edit = await collect(abs);
        if (edit) (call.interfaceEdits ??= []).push(edit);
        if (edit?.sourceChange) measured.push({ ...edit.sourceChange,
          workspace: body.workspace, harness: body.harness, agentId: body.owner });
      } catch { /* an unreadable local repo cannot disturb the tool */ }
    }
  }
  const hasIncidentCall = (body.toolCalls ?? []).some(call =>
    /(?:^|[:_/.])(?:testing[:_]run|test[:_]file|run-tests)(?:$|[:_/.])/.test(call?.tool ?? ''));
  // Ordinary tool batches must stay on the existing fast path. The ledger read
  // is needed only when an observed test failure can consume retained edits, or
  // when this batch actually measured a new edit.
  if (!measured.length && !hasIncidentCall) return;
  // Retain measured comparisons across fresh hooks in the existing fenced
  // delivery ledger. This records observations, never inferred authorship.
  const recent = codeIntelDelivery(body.owner, env, state => {
    const rows = [...(Array.isArray(state.recentEdits) ? state.recentEdits : []), ...measured]
      .filter(row => row && Number.isFinite(row.at) && row.at <= Date.now() && Date.now() - row.at < 86_400_000);
    state.recentEdits = [...new Map(rows.map(row => [`${row.workspace}:${row.harness}:${row.root}:${row.path}`, row])).values()].slice(-8);
    return state.recentEdits.filter(row => row.workspace === body.workspace && row.harness === body.harness);
  });
  if (recent?.length) body.incidentAttribution = { status: 'measured', recentEdits: recent };
}

/** Async preparation shared by native Edit/Write/MultiEdit and apply_patch.
 * The push registry receives only bounded findings; it never scans source. */
export async function collectCloneEdits(body, digest = async path => {
  if ((await stat(path)).size > 1_500_000) return null;
  const source = await readFile(path);
  return source.length <= 1_500_000 ? createHash('sha256').update(source).digest('hex') : null;
}) {
  const seen = new Set();
  const pending = [];
  for (const call of (body.toolCalls ?? []).slice(-20)) {
    if (!/(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? '')) continue;
    for (const path of (call.editedPaths ?? []).slice(0, 20)) {
      if (typeof path !== 'string' || !/\.tsx?$/.test(path)) continue;
      const abs = resolve(body.cwd || process.cwd(), path);
      const rel = relative(body.cwd || process.cwd(), abs).replaceAll('\\', '/');
      if (rel.startsWith('../') || seen.has(rel) || seen.size >= 20) continue;
      seen.add(rel);
      pending.push(Promise.resolve().then(() => digest(abs)).then(sha256 => {
        if (sha256) (call.cloneEdits ??= []).push({ path: rel, sha256 });
      }, () => {}));
    }
  }
  await Promise.all(pending);
}

export async function collectAntipatternEdits(body, prepare = async (path, root) => new Promise(resolveResult => {
  const worker = join(root, 'packages/operator-core/lib/code-intelligence/agent-antipatterns-worker.ts');
  execFile(process.execPath, [worker, path], { cwd: root, timeout: 600, maxBuffer: 100_000 }, (error, stdout) => {
    try { resolveResult(error || !stdout ? null : JSON.parse(stdout)); } catch { resolveResult(null); }
  });
})) {
  const { findRepoRoot } = await import('../cc/posttooluse-required-field-strand-nudge.mjs');
  const paths = new Set();
  const pending = [];
  for (const call of body.toolCalls ?? []) {
    if (!/(?:^|_|:|\.)(?:Edit|Write|MultiEdit|edit|write|apply_patch)$/.test(call.tool ?? '')) continue;
    for (const path of call.editedPaths ?? []) {
      const abs = resolve(body.cwd || process.cwd(), path);
      if (paths.has(abs) || paths.size >= 4 || !/\.tsx?$/.test(abs)) continue;
      paths.add(abs);
      const root = findRepoRoot(abs);
      if (!root) continue;
      pending.push(Promise.resolve().then(() => prepare(abs, root)).then(result => {
        if (result) (call.antipatternEdits ??= []).push(result);
      }, () => {}));
    }
  }
  await Promise.all(pending);
}

function mergeCodeIntel(body, delivered, env) {
  const edits = [...new Map((body.toolCalls ?? []).flatMap(call => call.interfaceEdits ?? [])
    .filter(edit => edit && typeof edit.path === 'string' && Array.isArray(edit.changes)
      && edit.changes.every(value => typeof value === 'string') && Array.isArray(edit.checks)
      && edit.checks.every(value => typeof value === 'string'))
    .map(edit => [edit.path, edit])).values()];
  const blocks = delivered.split(/(?=^## )/m);
  const ordinary = blocks.filter(block => !block.startsWith('## Code intelligence')).join('').trim();
  const optional = blocks.filter(block => block.startsWith('## Code intelligence')).map(block => block.trim());
  if (!optional.length && !edits.length) return delivered;
  const reserved = codeIntelDelivery(body.owner, env, state => {
    const out = [];
    const subject = edit => `interface:${edit.path}:${edit.changes.join('|')}`;
    const take = (text, keys) => {
      if (keys.some(key => state.subjects.includes(key)) || state.chars + text.length + 2 + ordinary.length > 1500) return;
      out.push(text); state.chars += text.length + 2; state.subjects.push(...keys);
    };
    for (const block of optional) {
      const matches = block.startsWith('## Code intelligence (interface)') ? edits.filter(edit => block.includes(`${edit.path}:`)) : [];
      take(block, matches.length ? matches.map(subject) : [createHash('sha256').update(block).digest('hex')]);
    }
    for (const edit of edits) {
      if (!Array.isArray(edit.changes) || !Array.isArray(edit.checks)) continue;
      take(`## Code intelligence (interface)\nLocal comparison base ${edit.base || 'unknown'}\n${edit.path}: ${edit.changes.join('; ')}.\n${edit.checks.join('\n')}\nSnapshot consequences unavailable; consumer and test reach unknown.`, [subject(edit)]);
    }
    return out.join('\n\n');
  });
  return [ordinary, reserved].filter(Boolean).join('\n\n');
}

/** Keep native patch headers outside the lossy recall digest, including multi-file patches. */
export function editedPathsFor(tool, input) {
  // `write` is also a generic MCP tool name (for example coord/tool writes),
  // so only recognize the client-native file edit spellings here. Treating a
  // generic write as a file edit leaks arbitrary tool arguments into the
  // interface-consequence advisory and changes the digest contract.
  if (/^(?:Edit|Write|MultiEdit|edit)$|(?:^|[_:.])capability[_:.](?:edit|write)$/.test(tool ?? '')) {
    const path = input?.file_path ?? input?.path;
    return typeof path === 'string' && path.length <= 1000 ? [path] : [];
  }
  if (!/(?:^|_|:|\.)(?:apply_patch)$/.test(tool ?? '')) return [];
  const patch = typeof input === 'string' ? input : input?.command ?? input?.patch ?? input?.input;
  if (typeof patch !== 'string' || patch.length > 2_000_000) return [];
  return [...new Set([...patch.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm)].map(match => match[1]))]
    .filter(path => path.length <= 1000).slice(0, 12);
}

/**
 * Clamp a value to a string of at most `max` chars.
 *
 * ⚠ CLAMP CLIENT-SIDE, NOT SERVER-SIDE (invariant 5). A tool_response can be
 * megabytes (a big grep, a whole-file read) and mid-turn runs on EVERY batch —
 * shipping raw batches would make the transport itself the dominant cost. The
 * server only needs enough text to form a query.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clampField(value, max) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : safeStringify(value);
  return text.slice(0, max);
}

/** @param {unknown} value @returns {string} */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Cyclic or otherwise unserializable tool payloads must not break a turn.
    return '';
  }
}

/**
 * Build the mid-turn digest from an already-normalised call list, applying the
 * contract clamps. Shared by every adapter so the three clients cannot drift
 * into shipping different volumes of context for the same batch.
 * @param {Array<{ tool?: unknown, toolInput?: unknown, toolResponse?: unknown }>} calls
 * @returns {Array<{ tool: string, toolInput: string, toolResponse: string, querySignals: import('./recall-query.mjs').RecallSignals,
 * incidentResult?: ReturnType<typeof incidentResultFor>, editedPaths?: string[], editedPath?: string }>}
 */
export function buildDigest(calls) {
  const spec = PORTS['mid-turn'];
  if (!Array.isArray(calls)) return [];
  const digest = [];
  for (const rawCall of calls.slice(0, spec.maxCalls)) {
    if (!rawCall || typeof rawCall !== 'object') continue;
    // Classify the call a `tools:invoke` wrapper dispatched, not the wrapper. The
    // server normalizes too, but only the client holds the unclamped input and
    // response, so incidentResult/editedPaths must be derived from the inner call here.
    const call = { ...rawCall, ...unwrapInvokedCall(rawCall.tool, rawCall.toolInput) };
    const incidentResult = incidentResultFor(call.tool, call.toolResponse);
    const editedPaths = editedPathsFor(call.tool, call.toolInput);
    digest.push({
      tool: typeof call.tool === 'string' ? call.tool : '',
      querySignals: extractRecallSignals(call.tool, call.toolInput, call.toolResponse),
      toolInput: clampField(call.toolInput, spec.fieldClamp),
      toolResponse: clampField(call.toolResponse, spec.fieldClamp),
      ...(incidentResult ? { incidentResult } : {}),
      // Preserve the path independently of the 400-char recall digest. Edits often
      // exceed it, and a truncated JSON input cannot safely recover this field.
      ...(editedPaths.length ? { editedPaths, editedPath: editedPaths[0] } : {}),
    });
  }
  return digest;
}

/** `tools:invoke` and its MCP-mangled form (`mcp__…_tools_invoke`); the same
 * pattern as the server's TOOLS_INVOKE_RE (push-channel.ts). */
const TOOLS_INVOKE_RE = /(?:^|_|:)tools[_:]invoke$/;

/**
 * The inner call of a `tools:invoke { name, args }` dispatch, one level only.
 * Returns the original `{ tool, toolInput }` for any other call, or when the
 * wrapper's input carries no usable name. About half of all `testing:run` calls
 * arrive wrapped (measured 2026-10-27: 392 of 772 in 36h), and the incident leg
 * matches on the inner tool name.
 * @param {unknown} tool
 * @param {unknown} input
 * @returns {{ tool: unknown, toolInput: unknown }}
 */
export function unwrapInvokedCall(tool, input) {
  if (typeof tool !== 'string' || !TOOLS_INVOKE_RE.test(tool)) return { tool, toolInput: input };
  let outer = input;
  if (typeof outer === 'string') {
    if (outer.length > 2_000_000) return { tool, toolInput: input };
    try { outer = JSON.parse(outer); } catch { return { tool, toolInput: input }; }
  }
  const name = outer && typeof outer === 'object' && !Array.isArray(outer) ? outer.name : undefined;
  if (typeof name !== 'string' || !name) return { tool, toolInput: input };
  return { tool: name, toolInput: outer.args };
}

/** Preserve observed failing-file identities outside the lossy recall prefix.
 * Requested files, refusals and passing rows are never failure evidence. */
export function incidentResultFor(tool, response, depth = 0) {
  if (!/(?:^|[:_/.])(?:testing[:_]run|test[:_]file|run-tests)(?:$|[:_/.])/.test(tool ?? '') || depth > 5) return null;
  if (typeof response === 'string') {
    if (response.length > 512_000) return null;
    try { return incidentResultFor(tool, JSON.parse(response), depth + 1); } catch { return null; }
  }
  if (!response || typeof response !== 'object') return null;
  if (response.structuredContent) return incidentResultFor(tool, response.structuredContent, depth + 1);
  // A client may hand the hook the MCP content-block array itself rather than
  // `{ content: [...] }`; read both shapes the same way.
  const blocks = Array.isArray(response) ? response : response.content;
  for (const block of (Array.isArray(blocks) ? blocks.slice(0, 8) : [])) {
    if (block?.type !== 'text') continue;
    const found = incidentResultFor(tool, block.text, depth + 1);
    if (found) return found;
  }
  const byFile = {};
  const rows = response.byFile && typeof response.byFile === 'object' ? Object.entries(response.byFile) : [];
  for (const value of (Array.isArray(response.files) ? response.files.slice(0, 64) : [])) {
    if (value && typeof value === 'object') rows.push([value.path ?? value.file ?? value.filePath, value]);
  }
  for (const [path, row] of rows.slice(0, 64)) {
    if (typeof path !== 'string' || path.length > 4096 || !row || typeof row !== 'object') continue;
    if (row.status !== 'fail' && row.status !== 'error' && !(row.failed > 0) && row.collectionFailed !== true) continue;
    byFile[path] = { status: 'fail', failed: 1,
      ...(Number.isSafeInteger(row.runId) && row.runId > 0 ? { runId: row.runId } : {}) };
    if (Object.keys(byFile).length >= 4) break;
  }
  return Object.keys(byFile).length ? { byFile } : null;
}

/**
 * The pre-tool guard's view of one pending call (P-011, D-023 §3). Shared by
 * every adapter so the clients cannot drift on what a guard gets to see.
 *
 * ⚠ WHOLE UP TO THE BOUND, THEN NOTHING — never a lossy prefix. A guard reads
 * fields of the input; a clamp that cut it could hide exactly the tail a deny
 * rule would have matched. Over the bound the input is dropped and flagged, and
 * the server refuses the call for any guard that matches the tool.
 *
 * @param {unknown} tool
 * @param {unknown} input
 * @returns {{ tool: string, input: unknown } | { tool: string, inputTruncated: true } | null}
 */
export function guardCall(tool, input) {
  if (typeof tool !== 'string' || !tool) return null;
  const serialized = safeStringify(input ?? null);
  // An unserializable input is one the guard cannot see: treat it as cut.
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > PORTS['pre-tool'].guardInputMaxBytes) {
    return { tool, inputTruncated: true };
  }
  return { tool, input: input ?? null };
}

/**
 * Clamp a turn-start prompt to the contract length.
 * @param {unknown} prompt
 * @returns {string}
 */
export function clampPrompt(prompt) {
  return typeof prompt === 'string' ? prompt.slice(0, PORTS['turn-start'].promptClamp) : '';
}

const SHELL_PRE_TOOL_NAMES = new Set(['Bash', 'bash', 'exec_command', 'shell_command', 'shell']);
const PLAN_ANCHOR_REPAIR_KEYS = new Set(['slug', 'harness', 'itemId', 'anchors', 'expectedHash', 'rationale']);
const CANONICAL_GRADING_AUDIT_AWAIT_EVENT = /^scorecard:grading-audit:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Codex keeps native tools under the `functions.` namespace in hook events. */
function authorizationToolName(tool) {
  return typeof tool === 'string' ? tool.replace(/^functions\./, '') : '';
}

/**
 * Read the command carried by a native shell-tool event.
 * @param {{ input?: unknown, toolInput?: unknown }} partial
 * @returns {string | null}
 */
function shellCommandFromPartial(partial) {
  const input = partial?.input ?? partial?.toolInput;
  if (!input || typeof input !== 'object') return null;
  if (typeof input.cmd === 'string') return input.cmd;
  return typeof input.command === 'string' ? input.command : null;
}

/** Reject active interpolation and unfinished quoting, preserving literal arguments. */
function hasActiveShellExpansion(command) {
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (!next) return true;
      if (quote !== '"' || /["\\$`]/.test(next)) i++;
      continue;
    }
    if (char === "'" && quote === null) quote = "'";
    else if (char === '"') quote = quote === '"' ? null : '"';
    else if (char === '$' || char === '`') return true;
  }
  return quote !== null;
}

/**
 * Parse a bounded shell command into simple invocations. Newlines, semicolons,
 * logical AND/OR, and a pipe separate command segments; every stage must independently
 * match the read-only allowlist. The only redirections admitted are ones that cannot
 * create or modify a file: discarding output to /dev/null (`2>/dev/null`, `>/dev/null`)
 * and duplicating a descriptor (`2>&1`). The fd number before a redirect stays in the
 * segment's tokens (shell-quote does not keep adjacency), so allowlists see it as an
 * ordinary argument and judge conservatively. Other shell operators stay fail-closed.
 * Split newlines before parsing because shell-quote treats them as whitespace.
 * @param {string} command
 * @returns {string[][] | null}
 */
function readOnlyCommandSegments(command) {
  if (command.length > 16_384 || command.includes(String.fromCharCode(0))) return null;

  const normalized = command.replace(/\r\n/g, '\n');
  if (normalized.includes(String.fromCharCode(13))) return null;
  const segments = [];
  for (const line of normalized.split('\n')) {
    if (!line.trim()) continue;
    if (line.trimEnd().endsWith('\\') || hasActiveShellExpansion(line)) return null;

    let tokens;
    try {
      tokens = parseShellCommand(line);
    } catch {
      return null;
    }
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    let current = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (typeof token === 'string') {
        current.push(token);
        continue;
      }
      // A literal filename prefix prevents glob expansion into leading options.
      // Never admit globs as command names or helper/option switches.
      if (token?.op === 'glob' && typeof token.pattern === 'string' &&
          /^[A-Za-z0-9_./]/.test(token.pattern) && current.length > 0) {
        current.push(token.pattern);
        continue;
      }
      if (token && typeof token === 'object' &&
          (token.op === ';' || token.op === '&&' || token.op === '||' || token.op === '|') && current.length > 0) {
        segments.push(current);
        current = [];
        continue;
      }
      const target = tokens[i + 1];
      if (token && typeof token === 'object' && current.length > 0 && typeof target === 'string' &&
          (((token.op === '>' || token.op === '>>') && target === '/dev/null') ||
           (token.op === '>&' && /^\d$/.test(target)))) {
        i++;
        continue;
      }
      return null;
    }
    if (current.length === 0) return null;
    segments.push(current);
    if (segments.length > 16) return null;
  }
  return segments.length > 0 ? segments : null;
}

/**
 * Permit only ripgrep commands that cannot execute configured helpers while
 * authority lookup is unavailable.
 * @param {string[]} tokens
 * @param {NodeJS.ProcessEnv} env
 */
function isReadOnlyRipgrepInvocation(tokens, env) {
  if (tokens[0] !== 'rg') return false;
  const args = tokens.slice(1);
  if (args.some(arg => /^--(?:pre|pre-glob|config-path)(?:=|$)/.test(arg))) return false;
  if (typeof env.RIPGREP_CONFIG_PATH === 'string' && env.RIPGREP_CONFIG_PATH.trim() && !args.includes('--no-config')) return false;
  return true;
}

/** ps only reads process metadata; shell operators and interpolation are rejected earlier. */
function isReadOnlyProcessListInvocation(tokens) {
  return tokens[0] === 'ps';
}

/** Only the reported Git plumbing reads bypass authority when it is unavailable. */
function isReadOnlyGitInspectionInvocation(tokens) {
  return tokens[0] === 'git' &&
    (tokens[1] === 'rev-parse' || tokens[1] === 'ls-tree') &&
    tokens.length > 2;
}

/** head reads files/stdin and writes only to stdout; shell redirections are rejected earlier. */
function isReadOnlyHeadInvocation(tokens) {
  return tokens[0] === 'head';
}

/**
 * Everyday inspection utilities that read files/stdin and write only to stdout
 * (EI-28725785038939067: agents' real read commands routinely wrap these around
 * rg/sed, so a fallback that admitted only bare rg/head/cat/sed/ps refused most
 * reads whenever the authority lookup hit its wall). Options that write a file or
 * execute a helper are refused: `sort -o`/`--output`/`--compress-program`, and
 * uniq's optional OUTPUT operand (uniq is admitted stdin-only).
 * @param {string[]} tokens
 */
function isReadOnlyInspectionUtilityInvocation(tokens) {
  const [tool, ...args] = tokens;
  switch (tool) {
    case 'cd':
      return args.length <= 1;
    case 'pwd':
    case 'true':
    case 'echo':
    case 'ls':
    case 'wc':
    case 'grep':
    case 'tail':
    case 'cut':
      return true;
    case 'sort':
      return !args.some(arg => /^--(?:output|compress-program)(?:=|$)/.test(arg) || /^-[^-]*o/.test(arg));
    case 'uniq':
      return args.every(arg => arg.startsWith('-'));
    default:
      return false;
  }
}

/**
 * `timeout [options] DURATION command...` only bounds the wrapped command, so judge
 * the wrapped command. Returns the segment unchanged when it is not a timeout
 * wrapper, or null when the wrapper is malformed.
 * @param {string[]} tokens
 * @returns {string[] | null}
 */
function unwrapTimeoutInvocation(tokens) {
  if (tokens[0] !== 'timeout') return tokens;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += ['-s', '-k', '--signal', '--kill-after'].includes(tokens[i]) ? 2 : 1;
  }
  if (i >= tokens.length || !/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i])) return null;
  const wrapped = tokens.slice(i + 1);
  return wrapped.length > 0 ? wrapped : null;
}

/**
 * cat accepts only input paths; sed accepts only explicit line-range printing.
 * @param {string[]} tokens
 */
function isReadOnlyFileReadInvocation(tokens) {
  if (tokens.length < 2) return false;
  const [tool, ...args] = tokens;
  if (tool === 'cat') {
    return args.length > 0 && args.every(arg => arg.length > 0 && !arg.startsWith('-'));
  }
  if (tool !== 'sed' || args.length < 3 || args[0] !== '-n') return false;
  if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p(?:[ \t]*;[ \t]*(?:\d+|\$)(?:,(?:\d+|\$))?p)*$/.test(args[1])) return false;
  const inputFiles = args.slice(2);
  return inputFiles.length > 0 && inputFiles.every(arg => arg.length > 0 && !arg.startsWith('-'));
}

/**
 * Validate only the two documented plans:edit repair shapes. The target tool
 * still performs schema, CAS, lint and capability checks after this shell-level
 * admission; implementation tools remain behind the live authority verdict.
 * @param {unknown} args
 */
function isCanonicalPlanEditArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = /** @type {Record<string, unknown>} */ (args);
  if (typeof value.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(value.slug) ||
      (value.harness !== undefined &&
        (typeof value.harness !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.harness))) ||
      (value.expectedHash !== undefined && typeof value.expectedHash !== 'string') ||
      (value.rationale !== undefined && typeof value.rationale !== 'string')) return false;
  const hasAnchorFields = Object.hasOwn(value, 'itemId') || Object.hasOwn(value, 'anchors');
  const hasTextFields = Object.hasOwn(value, 'old_string') || Object.hasOwn(value, 'new_string');
  if (hasAnchorFields === hasTextFields) return false;
  const allowedKeys = hasAnchorFields ? PLAN_ANCHOR_REPAIR_KEYS : PLAN_TEXT_REPAIR_KEYS;
  if (Object.keys(value).some(key => !allowedKeys.has(key))) return false;
  if (hasAnchorFields) {
    return typeof value.itemId === 'string' && /^P-\d{3,}$/.test(value.itemId) &&
      Array.isArray(value.anchors) && value.anchors.length > 0 && value.anchors.length <= 32;
  }
  if (typeof value.old_string !== 'string' || value.old_string.length === 0 ||
      typeof value.new_string !== 'string' || value.old_string === value.new_string ||
      (value.replace_all !== undefined && value.replace_all !== false) ||
      (value.allowDecisionDrop !== undefined && value.allowDecisionDrop !== false)) return false;
  return true;
}

/**
 * Admit only pre-start plan audit phases. The plans:audit tool remains the
 * authority for its detailed mappings and whether an audit can be recorded.
 * Completion audits are intentionally excluded from this recovery path.
 * @param {unknown} args
 */
function isCanonicalPlanAuditArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = /** @type {Record<string, unknown>} */ (args);
  if (typeof value.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(value.slug) ||
      (value.harness !== undefined &&
        (typeof value.harness !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.harness))) ||
      typeof value.dryRun !== 'boolean' ||
      typeof value.phase !== 'string' || !PLAN_AUDIT_PRESTART_PHASES.has(value.phase)) return false;
  const allowedKeys = value.phase === 'activation'
    ? new Set([...PLAN_AUDIT_BASE_KEYS, ...PLAN_AUDIT_ACTIVATION_KEYS])
    : PLAN_AUDIT_BASE_KEYS;
  if (Object.keys(value).some(key => !allowedKeys.has(key))) return false;
  return value.classRef === undefined ||
    (value.phase === 'activation' && typeof value.classRef === 'string' && PLAN_AUDIT_CLASS_REFS.has(value.classRef));
}

/**
 * Remove one inert, bounded ptool idempotency token before parsing the canonical
 * command header. Reject duplicates and shell metacharacters instead of
 * expanding them away.
 * @param {string} header
 * @returns {{header:string,idempotencyKey:string|null}|null}
 */
function stripCanonicalPtoolIdempotencyKey(header) {
  const matches = [...header.matchAll(/[ \t]+--idempotency-key(?:=|[ \t]+)([A-Za-z0-9][A-Za-z0-9._:-]{0,199})(?=[ \t]|$)/g)];
  if (matches.length > 1) return null;
  if (matches.length === 0) return { header, idempotencyKey: null };
  const match = matches[0];
  const start = match.index ?? -1;
  if (start < 0) return null;
  return {
    header: header.slice(0, start) + header.slice(start + match[0].length),
    idempotencyKey: match[1],
  };
}

/**
 * Permit a typed canonical plans:edit repair through a quoted ptool heredoc.
 * The operator still validates and authorizes the target tool call.
 * @param {string} command
 */
function isCanonicalPlanEditCommand(command) {
  if (command.length > 32_768 || command.includes(String.fromCharCode(0))) return false;
  const lines = command.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3) return false;

  const header = lines.shift();
  const closingDelimiter = lines.pop();
  const match = /^(.*)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  if (!match || closingDelimiter !== match[2] || lines.includes(match[2])) return false;
  const commands = readOnlyCommandSegments(match[1]);
  if (commands?.length !== 1) return false;
  const [tool, verb, ...args] = commands[0];
  if (tool !== 'ptool' || verb !== 'plans:edit') return false;
  let jsonStdin = false;
  let explicitUrl = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !jsonStdin && args[i + 1] === '-') {
      jsonStdin = true;
      i++;
    } else if (/^--(?:workspace|harness)=[A-Za-z0-9._-]+$/.test(arg)) {
      continue;
    } else if (!explicitUrl && (arg === '--url' || arg.startsWith('--url='))) {
      const url = arg === '--url' ? args[++i] : arg.slice('--url='.length);
      // The maintained local staging operator is the only extra destination.
      // Never forward the session bearer to an arbitrary host or audit sidecar.
      if (typeof url !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):3170\/?$/.test(url)) return false;
      explicitUrl = true;
    } else {
      return false;
    }
  }
  if (!jsonStdin) return false;

  let payload;
  try {
    payload = JSON.parse(lines.join('\n'));
  } catch {
    return false;
  }
  return isCanonicalPlanEditArgs(payload);
}

/**
 * A recovery await is an operational subscription, not an implementation
 * write. Keep the fallback narrower than events:await itself: only the
 * canonical scorecard grading-audit family, with a one-shot wake and a
 * bounded deadline, is safe when the authority lookup has no verdict.
 * @param {unknown} args
 */
function isCanonicalGradingAuditAwait(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = /** @type {Record<string, unknown>} */ (args);
  if (Object.keys(value).some(key => !['event', 'timeout_sec', 'on_timeout'].includes(key))) return false;
  if (typeof value.event !== 'string' || !CANONICAL_GRADING_AUDIT_AWAIT_EVENT.test(value.event)) return false;
  if (typeof value.timeout_sec !== 'number' || !Number.isSafeInteger(value.timeout_sec) ||
      value.timeout_sec < 1 || value.timeout_sec > 3600) return false;
  return value.on_timeout === 'wake';
}

/**
 * Normalize the documented ptool_scope wrapper only for a tools:find heredoc.
 * Validate the resolved scope values before replacing the array expansion with
 * the existing canonical env-reference form; never evaluate shell syntax.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function normalizeCanonicalPtoolScopeFind(command, env) {
  const normalized = command.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return null;
  const prelude = [
    'ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")',
    'if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]; then',
    '  ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")',
    'fi',
  ].join('\n') + '\n';
  if (!normalized.startsWith(prelude)) return normalized;

  const rest = normalized.slice(prelude.length);
  const newline = rest.indexOf('\n');
  if (newline < 0) return null;
  const header = rest.slice(0, newline);
  const match = /^ptool[ \t]+tools:find[ \t]+--json[ \t]+-[ \t]+"\$\{ptool_scope\[@\]\}"[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  if (!match) return null;

  const workspace = env.PAPERCUSP_WORKSPACE;
  if (typeof workspace !== 'string' || !/^[A-Za-z0-9._-]+$/.test(workspace)) return null;
  const harness = env.PAPERCUSP_HARNESS_SLUG;
  const hasHarness = typeof harness === 'string' && harness.length > 0;
  if (hasHarness && !/^[A-Za-z0-9._-]+$/.test(harness)) return null;

  const scopes = ' --workspace="$PAPERCUSP_WORKSPACE"' +
    (hasHarness ? ' --harness="$PAPERCUSP_HARNESS_SLUG"' : '');
  return 'ptool tools:find --json -' + scopes + " <<'" + match[1] + "'\n" + rest.slice(newline + 1);
}

/**
 * A bounded, single typed operator call cannot run arbitrary shell code. The
 * read-only diagnostics enforce their own role and input constraints at the
 * operator. These calls still cross the authenticated operator; an actual
 * guard refusal always wins.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 */
function isCanonicalReviewPtoolCommand(command, env) {
  if (command.length > 32_768 || command.includes(String.fromCharCode(0))) return false;
  const normalized = normalizeCanonicalPtoolScopeFind(command, env);
  if (normalized === null) return false;
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3) return false;
  let header = lines.shift();
  const closingDelimiter = lines.pop();
  let idempotencyKey = null;
  // ptool's explicit staging route never forwards the bearer to another host.
  // Remove at most one exact flag; duplicates and all other URLs still fail
  // the canonical header parser below.
  if (header.startsWith('ptool ')) {
    // Discarding diagnostics is inert. Other redirections, duplicates and
    // shell operators still fail the complete canonical-header parser below.
    header = header.replace(/[ \t]+2>\/dev\/null(?=[ \t]|$)/, '');
    const normalized = stripCanonicalPtoolIdempotencyKey(header);
    if (!normalized) return false;
    header = normalized.header;
    idempotencyKey = normalized.idempotencyKey;
    header = header.replace(/[ \t]+--url=http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):3170\/?(?=[ \t])/, '');
  }
  const pinned = /^node[ \t]+scripts\/mcp-call\.mjs[ \t]+--port(?:[ \t]+|=)([1-9][0-9]{0,4})[ \t]+([a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*)[ \t]+--json[ \t]+-(?:[ \t]+--allow-partial)?[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  if (pinned && (Number(pinned[1]) > 65535 ||
      !['scorecards:get', 'capability:read', 'capability:git-evidence', 'tools:find'].includes(pinned[2]))) return false;
  // mcp-call validates its explicit port as a loopback-only destination. Keep
  // this recovery form limited to evidence reads and the inherited identity.
  const scoped = /^ptool[ \t]+([a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*)((?:[ \t]+--(?:workspace|harness)(?:=(?:"[^"\t\r\n ]*"|'[^'\t\r\n ]*'|[A-Za-z0-9._-]+)|[ \t]+(?:"[^"\t\r\n ]*"|'[^'\t\r\n ]*'|[A-Za-z0-9._-]+)))*)[ \t]+--json[ \t]+-((?:[ \t]+--(?:workspace|harness)(?:=(?:"[^"\t\r\n ]*"|'[^'\t\r\n ]*'|[A-Za-z0-9._-]+)|[ \t]+(?:"[^"\t\r\n ]*"|'[^'\t\r\n ]*'|[A-Za-z0-9._-]+)))*)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  // ptool accepts scopes on either side of --json -. Validate their combined
  // set so reordering cannot evade duplicate-scope or environment checks.
  const match = pinned ? [pinned[0], pinned[2], '', pinned[3]] :
    scoped ? [scoped[0], scoped[1], scoped[2] + scoped[3], scoped[4]] : null;
  if (!match || closingDelimiter !== match[3] || lines.includes(match[3])) return false;
  const seenScopes = new Set();
  const scopeTokens = match[2].trim().split(/[ \t]+/).filter(Boolean);
  for (let index = 0; index < scopeTokens.length; index++) {
    let scope = /^--(workspace|harness)=(.+)$/.exec(scopeTokens[index]);
    let rawValue;
    if (scope) {
      rawValue = scope[2];
    } else {
      scope = /^--(workspace|harness)$/.exec(scopeTokens[index]);
      if (!scope || index + 1 >= scopeTokens.length) return false;
      rawValue = scopeTokens[++index];
    }
    if (seenScopes.has(scope[1])) return false;
    seenScopes.add(scope[1]);

    const quote = rawValue.startsWith('"') && rawValue.endsWith('"') ? '"' :
      rawValue.startsWith("'") && rawValue.endsWith("'") ? "'" : null;
    const value = quote ? rawValue.slice(1, -1) : rawValue;
    const reference = /^\$(?:([A-Z_][A-Z0-9_]*)|\{([A-Z_][A-Z0-9_]*)\})$/.exec(value);
    if (reference) {
      const name = reference[1] ?? reference[2];
      const expectedName = scope[1] === 'workspace' ? 'PAPERCUSP_WORKSPACE' : 'PAPERCUSP_HARNESS_SLUG';
      const resolved = env[name];
      if (quote !== '"' || name !== expectedName ||
          typeof resolved !== 'string' || !/^[A-Za-z0-9._-]+$/.test(resolved)) return false;
    } else if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      return false;
    }
  }
  try {
    const payload = JSON.parse(lines.join('\n'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    let tool = match[1];
    let toolArgs = payload;
    let hasInvokeProjection = false;
    if (tool === 'tools:invoke') {
      if (Object.keys(payload).some(key => !['name', 'args', 'projection'].includes(key)) ||
          typeof payload.name !== 'string' || !payload.args ||
          typeof payload.args !== 'object' || Array.isArray(payload.args)) return false;
      hasInvokeProjection = Object.hasOwn(payload, 'projection');
      tool = payload.name;
      toolArgs = payload.args;
    }
    if (tool === 'plans:edit') return !hasInvokeProjection && isCanonicalPlanEditArgs(toolArgs);
    if (tool === 'plans:audit') return !hasInvokeProjection && isCanonicalPlanAuditArgs(toolArgs);
    if (idempotencyKey !== null && !CANONICAL_UNVERDICTED_PTOOL_CONTROLS.includes(tool)) return false;
    if (tool === 'events:await') return isCanonicalGradingAuditAwait(toolArgs);
    // The pinned mcp-call verb has already passed its narrower evidence-read allowlist above.
    // Keep that decision authoritative here so the two-stage checks cannot drift apart.
    return (pinned !== null && pinned[2] === tool) || CANONICAL_UNVERDICTED_PTOOL_VERBS.includes(tool) ||
      CANONICAL_UNVERDICTED_PTOOL_CONTROLS.includes(tool);
  } catch {
    return false;
  }
}

/**
 * Typed ptool verbs admitted without a server verdict. The fail-closed deny
 * below names these same lists, so its suggested retry cannot drift from what the
 * guard actually admits (EI-28788424262267205).
 */
const CANONICAL_UNVERDICTED_PTOOL_VERBS = Object.freeze([
  'facts:list', 'tools:find', 'testing:runs', 'dev:pg_query', 'plans:get', 'plans:items', 'plans:evaluate-spec-quality', 'work_items:get', 'events:status', 'reports:get',
  'rubrics:get', 'scorecards:get', 'capability:read',
  'conversations:get', 'coord:inbox', 'coord:read', 'docs:get', 'docs:search',
  'dev:pipeline_position', 'locks:queue', 'loop:status',
  'consult:reply', 'consult:decline']);

// These are canonical readiness/coordination operations, matching the server's
// readinessControlPtoolTools policy. They still require the authenticated
// operator's role, custody and input checks; an actual server denial still wins.
// Same-session compaction preserves the existing authority rather than starting
// an implementation worker. Inert retry keys must remain usable after timeouts.
const CANONICAL_UNVERDICTED_PTOOL_CONTROLS = Object.freeze([
  'coord:send', 'coord:declare-intent', 'work_items:checkpoint', 'work_items:comment',
  'work_items:release', 'work_items:link', 'loop:checkpoint', 'session:request-compaction',
]);

/** Stages where no HTTP answer arrived at all. An HTTP status is the server
 * speaking and is never retried in search of a more permissive answer. */
const GUARD_TRANSPORT_MISS_STAGES = new Set(['wall-during-fetch', 'unreachable', 'request-failed']);

/**
 * Only a small set of non-implementation operations may pass through when the
 * remote execution-authority lookup itself is unavailable. Everything else
 * stays fail-closed.
 * @param {{ tool?: string, input?: unknown, toolInput?: unknown }} partial
 * @param {NodeJS.ProcessEnv} env
 */
function isSafeWithoutExecutionAuthority(partial, env) {
  if (!SHELL_PRE_TOOL_NAMES.has(authorizationToolName(partial?.tool))) return false;
  const command = shellCommandFromPartial(partial);
  if (command === null) return false;
  const segments = readOnlyCommandSegments(command);
  return (segments !== null && segments.every(segment => {
    const tokens = unwrapTimeoutInvocation(segment);
    return tokens !== null && (
      isReadOnlyRipgrepInvocation(tokens, env) ||
      isReadOnlyHeadInvocation(tokens) ||
      isReadOnlyFileReadInvocation(tokens) ||
      isReadOnlyProcessListInvocation(tokens) ||
      isReadOnlyGitInspectionInvocation(tokens) ||
      isReadOnlyInspectionUtilityInvocation(tokens));
  })) ||
    isCanonicalPlanEditCommand(command) || isCanonicalReviewPtoolCommand(command, env);
}

/**
 * The whole pipeline for one event, minus the client specifics.
 *
 * Adapters supply the three pure functions; this owns every decision that must
 * be identical across clients. Returns the STDOUT PAYLOAD STRING, or null for
 * "emit nothing" — deliberately a string, not an object, because each client's
 * payload shape is the adapter's business (claude/codex emit a JSON envelope,
 * omp emits bare text) and core must never parse or re-serialize it.
 *
 * @param {object} args
 * @param {import('./index.mjs').InjectionAdapter} args.adapter
 * @param {string} args.nativeEvent
 * @param {unknown} args.event
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(owner: string, env: NodeJS.ProcessEnv, port?: 'turn-start' | 'mid-turn' | 'compact') => import('./delivery-ledger.mjs').DeliveryLedger | null} [args.openDeliveryLedger]
 *   Native context ports opt into ACK-ON-PROOF: the last confirmed orientation token
 *   rides as `confirmedDelivery`, and the returned token is OFFERED to the ledger
 *   once a payload exists. Committing it is the caller's job, after it has actually
 *   written the payload — only the process that prints knows the print succeeded.
 * @returns {Promise<string | null>}
 */
export async function runInjection({ adapter, nativeEvent, event, env = process.env, fetchImpl, openDeliveryLedger }) {
  const trace = hookOutcomeTracer(env, { client: adapter?.client ?? null, nativeEvent: nativeEvent ?? null });
  let post = null;
  let unavailableMutationGuard = null;
  const done = (stage, value = null, extra = {}) => {
    trace?.({ stage, ...(post ? { post } : {}), ...extra });
    return value;
  };
  try {
    const owner = sessionId(env);
    if (!owner) return done('no-owner');

    const port = adapter.portForEvent(nativeEvent);
    if (!port || !specFor(port)) return done('no-port');

    const { off, mode } = killSwitchState(port, env);
    if (off && mode === 'suppress') return done('suppressed', null, { port });

    // parse() returning null means "no signal in this event" — e.g. an empty
    // batch, a blank prompt. Spend nothing: no request, no output.
    const partial = adapter.parse(port, event);
    if (!partial) return done('no-signal', null, { port });
    // EI-27540173897381380: an unavailable guard is not permission to mutate.
    // Context delivery retains its fail-silent contract; native edits and arbitrary
    // shell execution require an actual server verdict. Read/Grep/Glob still work.
    if (port === 'pre-tool' &&
        /^(?:Edit|Write|MultiEdit|edit|write|apply_patch|Bash|bash|exec_command|shell_command|shell|write_stdin)$/.test(authorizationToolName(partial.tool)) &&
        !isSafeWithoutExecutionAuthority(partial, env)) {
      unavailableMutationGuard = (error = null) => {
        // No trace-file opt-in should be needed to distinguish an HTTP refusal
        // from a timeout. Include only transport metadata, never request/response
        // bodies or exception messages, which may contain sensitive material.
        const detail = post
          ? `stage=${post.stage}; elapsedMs=${post.elapsedMs}; timeoutMs=${post.timeoutMs}` +
            (post.guardRequestId ? `; requestId=${post.guardRequestId}` : '') +
            (Number.isInteger(post.status) ? `; httpStatus=${post.status}` : '') +
            (post.transportPhase ? `; transportPhase=${post.transportPhase}; fetchMs=${post.fetchMs}; headersElapsedMs=${post.headersElapsedMs}; responseBodyMs=${post.responseBodyMs}` : '') +
            (post.operatorOrigin ? `; operatorOrigin=${post.operatorOrigin}` : '') +
            (post.guardAttempts?.length ? `; guardAttempts=${JSON.stringify(post.guardAttempts)}` : '') +
            (post.retriedAfter ? `; firstAttempt=${post.retriedAfter.stage}/${post.retriedAfter.elapsedMs}ms` +
              (post.retriedAfter.guardRequestId ? `; firstRequestId=${post.retriedAfter.guardRequestId}` : '') : '')
          : `stage=guard-threw; errorType=${error?.name ?? 'unknown'}`;
        // A blocked shell caller needs a retry that works while the operator is
        // slow, not only "restore access": name the typed read form admitted above.
        const readOnlyRetry = SHELL_PRE_TOOL_NAMES.has(authorizationToolName(partial.tool))
          ? " A canonical coordination/control or read call needs no native execution verdict in the typed form ptool <verb> --json - <<'JSON' " +
            '<args> JSON, where <verb> is one of: ' +
            [...CANONICAL_UNVERDICTED_PTOOL_VERBS, ...CANONICAL_UNVERDICTED_PTOOL_CONTROLS].join(', ') + '.'
          : '';
        return adapter.render('pre-tool',
          'plan_execution_not_ready: execution-authority lookup failed; no server verdict was received. ' +
          'This invocation was denied fail-closed because it may mutate state. Guard diagnostic: ' +
          detail + '. Restore operator access, then retry.' + readOnlyRetry, event);
      };
    }

    const detectorSessionKey =
      typeof env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY === 'string' &&
      env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY.trim()
        ? env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY.trim()
        : owner;
    // SessionStart shares fragment proofs with later hooks, while its token
    // stays in the existing compact namespace, separate from orientation ACKs.
    const ledger = (port === 'turn-start' || port === 'mid-turn' || port === 'compaction') && openDeliveryLedger
      ? openDeliveryLedger(owner, env, port === 'compaction' ? 'compact' : port) : null;
    const turnStartRequestId = port === 'turn-start' ? randomUUID() : null;
    const request = {
      ...baseRequest({ port, client: adapter.client, owner, cwd: partial.cwd, env }),
      ...partial,
      owner,
      client: adapter.client,
      // Keep the detector key explicit in the request while retaining the
      // public owner for memory recall. The producer copies the private key
      // used to sign MCP `?detector=` into this env carrier; the owner fallback
      // preserves older hook launches that predate the carrier.
      ...(port === 'mid-turn' ? { detectorSessionKey } : {}),
      ...(ledger && port === 'turn-start' ? { confirmedDelivery: ledger.confirmed() } : {}),
      ...(ledger && (port === 'mid-turn' || port === 'compaction') ? { memoryReceiptMode: true } : {}),
      ...(port === 'turn-start' && typeof ledger?.confirmedFactBodies === 'function' ? { confirmedFactBodies: ledger.confirmedFactBodies() } : {}),
      ...(typeof ledger?.confirmedMemoryDeliveries === 'function' ? { confirmedMemoryDeliveries: ledger.confirmedMemoryDeliveries() } : {}),
      ...(turnStartRequestId ? { turnStartRequestId } : {}),
    };

    const postOptions = {
      env,
      fetchImpl,
      ...(ledger ? { onTurnStartOutcome: outcome => ledger.recordOutcome(outcome) } : {}),
      onHookOutcome: outcome => { post = outcome; },
    };
    let response = await postInjection(port, request, postOptions);
    // EI-28788424262267205: a lookup that got NO HTTP answer is retried, each try
    // under its own wall, before the fail-closed deny below. Guard lookups are
    // idempotent reads with a fresh request id per try. Only calls that would be
    // denied pay for it; an HTTP status or an empty verdict is never retried.
    const attempts = Math.max(1, Math.floor(specFor(port).unavailableAttempts ?? 1));
    // Headers that arrived before a body stall are the server answering, so only
    // a lookup with no headers at all qualifies (headersElapsedMs stays null).
    for (let attempt = 1; unavailableMutationGuard && attempt < attempts && !response &&
        GUARD_TRANSPORT_MISS_STAGES.has(post?.stage) && post?.headersElapsedMs == null; attempt++) {
      const missed = post;
      post = null;
      response = await postInjection(port, request, postOptions);
      if (post) post = { ...post, retriedAfter: { stage: missed.stage, elapsedMs: missed.elapsedMs,
        ...(missed.guardRequestId ? { guardRequestId: missed.guardRequestId } : {}) } };
    }
    if (!response && post?.stage !== 'response-received' && unavailableMutationGuard)
      return done('guard-unavailable-deny', unavailableMutationGuard(), { port });
    const safeText = fenceControlTransition(response?.text ?? null, owner);
    if (!safeText) return done(response?.text ? 'fenced-empty' : 'no-text', null, { port });

    const payload = adapter.render(port, safeText, event);
    if (typeof payload !== 'string' || payload.length === 0) return done('render-empty', null, { port });
    if (ledger && response?.deliveryToken) ledger.offer(response.deliveryToken, {
      payload: payload + '\n',
      packingReceipt: response.packingReceipt,
      factBodyOffers: response.factBodyOffers,
      memoryFragmentOffers: response.memoryFragmentOffers,
      client: adapter.client,
      nativeSessionId: typeof event?.session_id === 'string' ? event.session_id
        : adapter.client === 'codex' ? env.CODEX_THREAD_ID : null,
      control: controlTransitionBlock(safeText)?.payload ?? null,
    });
    return done('emitted', payload, { port, payloadChars: payload.length });
  } catch (err) {
    if (unavailableMutationGuard)
      return done('guard-threw-deny', unavailableMutationGuard(err), { error: String(err?.message ?? err).slice(0, 300) });
    // Invariant 1, final backstop: an adapter bug must cost silence, not a turn.
    return done('runner-threw', null, { error: String(err?.message ?? err).slice(0, 300) });
  }
}

/**
 * Opt-in, diagnostic-only trace of why ONE hook invocation emitted what it did.
 * PAPERCUSP_HOOK_OUTCOME_FILE names an absolute JSONL path; unset (the default)
 * means no I/O at all. Every silent "emit nothing" exit of runInjection looks the
 * same on stdout, so without this an abort during local collection reads exactly
 * like an empty server answer (WI-6554700010042393). Writes one line per call and
 * never throws.
 *
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {object} base fields stamped on every record
 * @returns {((record: object) => void) | null}
 */
export function hookOutcomeTracer(env, base) {
  const file = typeof env?.PAPERCUSP_HOOK_OUTCOME_FILE === 'string' ? env.PAPERCUSP_HOOK_OUTCOME_FILE.trim() : '';
  if (!file || !isAbsolute(file)) return null;
  return record => {
    try {
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...base, ...record }) + '\n');
    } catch { /* diagnostic only */ }
  };
}
