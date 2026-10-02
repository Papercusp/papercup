/**
 * The label binds native tools (plan personal-data-reader-set-labels-2026-10-01,
 * P-007, BAR R-11).
 *
 * The gated outbound verbs (mail:send, chat:post, social:post, …) refuse a
 * recipient outside the reader sets of the restricted documents the agent has
 * read (disclosure-ledger.ts `assertDisclosurePermits`). That check is only a
 * binding if the agent cannot reach the provider any other way. This module is
 * the other half: a restricted session's shell and fetch tools may not name a
 * provider host, the mail/calendar sidecars, their databases, or the file
 * holding their secrets. Provider credentials are kept out of every agent
 * environment at launch (provider-egress.mjs `scrubProviderCredentials`).
 *
 * Decision order, cheapest first:
 *   1. No provider target in the text → allow. The ledger is not read, so the
 *      ordinary command pays only a regex scan.
 *   2. No attributable identity → allow. Delivery withholds restricted content
 *      from such a caller (D-004), so it cannot be restricted.
 *   3. The identity holds an unreleased disclosure → refuse
 *      `disclosure_egress_refused`.
 *   4. The ledger cannot be read → refuse `disclosure_ledger_unavailable`. A
 *      target was named and nobody can show the session is unrestricted.
 *
 * Callers: capability:bash (server side), and the PreToolUse hook for the
 * client-native Bash and WebFetch tools via POST /api/agent-mcp/restricted-egress-check.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ownerHasActiveDisclosure } from './git-sync-hold';
import { findProviderEgressTargets, type ProviderEgressTarget } from './provider-egress.mjs';

export const EGRESS_REFUSAL_CODE = 'disclosure_egress_refused' as const;

export type RestrictedEgressCode = typeof EGRESS_REFUSAL_CODE | 'disclosure_ledger_unavailable';

export interface RestrictedEgressVerdict {
  verdict: 'allow' | 'refuse';
  targets: ProviderEgressTarget[];
  /** Whether the session holds a disclosure; null when the ledger was not consulted or could not be read. */
  restricted: boolean | null;
  code: RestrictedEgressCode | null;
  reason: string | null;
}

export interface RestrictedEgressDeps {
  hasActiveDisclosure(ownerId: string): Promise<boolean>;
}

export const defaultRestrictedEgressDeps: RestrictedEgressDeps = {
  hasActiveDisclosure: (ownerId) => ownerHasActiveDisclosure(getOrgPg().sql, ownerId),
};

/** The gated verbs a restricted session must use instead, named in every refusal. */
export const GATED_OUTBOUND_VERBS = [
  'mail:send',
  'mail:reply',
  'mail:send-draft',
  'calendar:propose',
  'calendar:update',
  'chat:post',
  'chat:reply',
  'social:post',
  'social:reply',
] as const;

function describeTargets(targets: readonly ProviderEgressTarget[]): string {
  return targets.map((target) => `${target.match} (${target.rule})`).join(', ');
}

export async function checkRestrictedEgress(
  params: {
    ownerId: string | null | undefined;
    /** The tool being gated, e.g. `capability:bash`, `Bash`, `WebFetch`. */
    tool: string;
    /** The command, URL or other text the tool would act on. */
    texts: readonly string[];
    sidecarPorts?: readonly number[];
  },
  deps: RestrictedEgressDeps = defaultRestrictedEgressDeps,
): Promise<RestrictedEgressVerdict> {
  const targets = findProviderEgressTargets(params.texts, { sidecarPorts: params.sidecarPorts });
  if (!targets.length) return { verdict: 'allow', targets, restricted: null, code: null, reason: null };
  const ownerId = params.ownerId?.trim();
  if (!ownerId) return { verdict: 'allow', targets, restricted: null, code: null, reason: null };

  let restricted: boolean;
  try {
    restricted = await deps.hasActiveDisclosure(ownerId);
  } catch (error) {
    return {
      verdict: 'refuse',
      targets,
      restricted: null,
      code: 'disclosure_ledger_unavailable',
      reason:
        `${params.tool} names ${describeTargets(targets)}, and this session's disclosure ledger could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}); refusing rather than letting a possibly ` +
        `restricted session reach a provider directly. Retry once the operator database is reachable.`,
    };
  }
  if (!restricted) return { verdict: 'allow', targets, restricted: false, code: null, reason: null };
  return {
    verdict: 'refuse',
    targets,
    restricted: true,
    code: EGRESS_REFUSAL_CODE,
    reason:
      `${params.tool} names ${describeTargets(targets)}, but this session has read restricted personal data. ` +
      `A restricted session reaches mail, chat, calendar and social providers only through the gated verbs ` +
      `(${GATED_OUTBOUND_VERBS.join(', ')}), which check each recipient against the documents' reader sets. ` +
      `Use one of those verbs, or have the owner release the disclosure (personal:declassify).`,
  };
}

/** The capability:bash refusal payload for a refused verdict, or null to proceed. */
export function egressRefusalPayload(verdict: RestrictedEgressVerdict): {
  ok: false;
  reason: RestrictedEgressCode;
  targets: string[];
  message: string;
} | null {
  if (verdict.verdict !== 'refuse' || !verdict.code) return null;
  return {
    ok: false,
    reason: verdict.code,
    targets: verdict.targets.map((target) => target.rule),
    message: verdict.reason ?? '',
  };
}
