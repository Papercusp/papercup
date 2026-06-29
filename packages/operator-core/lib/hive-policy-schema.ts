/**
 * hive-policy-schema — the typed, versioned, forward-compatible Hive policy model
 * and the canonical signing surface (shared-hive-owner-enforcement-2026-06-19 EN-1).
 *
 * PURE: no I/O, no PG, no keychain. This module is the SINGLE SOURCE OF TRUTH for
 * the bytes the owner signs and a member verifies — the owner-side signer
 * (hive-policy-author.ts) and the member-side projection (projections/hive-policy.ts)
 * BOTH derive the signed bytes from {@link hivePolicySignedBytes}, so they can never
 * drift (a drift would silently reject every legit policy).
 *
 * FORWARD-COMPATIBILITY (EN-1 build step 2): a policy is an open record. Unknown keys
 * are PRESERVED, never dropped — the canonical form is computed over the WHOLE parsed
 * object, so an older peer that doesn't understand a newer field still (a) round-trips
 * it and (b) verifies the owner signature that covers it. The typed {@link HivePolicy}
 * fields are a *lens* over the stored document, not an exhaustive schema. Default =
 * absent policy ⇒ permissive (no enforcement); existing Hives are unaffected.
 */

/** Per-member rate caps (EN-2 P-RATE reads these). Absent ⇒ no limiting. */
export interface HivePolicyRate {
  opsPerMin?: number;
  rowsPerHour?: number;
  prsPerDay?: number;
}

/** Membership admission mode (EN-3 P-MEMBER). Absent ⇒ 'open' (today's behavior). */
export type HiveMembershipMode = 'open' | 'approval' | 'allowlist';

/** Moderation policy (EN-3 P-MOD). All optional; absent ⇒ no moderation. */
export interface HivePolicyModeration {
  /** A member may file `report`s against content/members. */
  reportable?: boolean;
  /** GitHub user ids the owner banned (EN-3 reads for rejoin-deny + revoke teeth). */
  bannedGithubIds?: string[];
  /** Content refs the owner took down (EN-3 honors as federated tombstones). */
  takedownList?: string[];
}

/**
 * The typed view of a Hive policy document. This is a forward-compatible OPEN record:
 * the named fields are the EN-1..EN-4 surface, and `[k: string]: unknown` preserves
 * any field a newer authoring client added. The whole object is owner-signed.
 */
export interface HivePolicy {
  rate?: HivePolicyRate;
  membership?: HiveMembershipMode;
  allowlist?: string[];
  moderation?: HivePolicyModeration;
  /** P-018 / D-012 — federated content write authority. 'member' (default for trusted hives) =
   *  any member may overwrite/delete any row (today's behavior). 'author-scoped' = only a row's
   *  owner (its first writer) or a privileged identity may mutate it. Absent ⇒ resolved by
   *  resolveContentWriteMode (an `open` hive defaults to 'author-scoped'). */
  contentWriteAuthority?: 'member' | 'author-scoped';
  /** EN-4 P-CONTRIB — fork→PR contribution rules. Opaque at EN-1. */
  contrib?: Record<string, unknown>;
  /** EN-4 P-CONTENT — payload/content rules. Opaque at EN-1. */
  content?: Record<string, unknown>;
  /** Forward-compat: any field a newer authoring client added is preserved + signed. */
  [k: string]: unknown;
}

/**
 * Domain-separation tag for the signed message. Binds the signature to THIS protocol
 * + version so a hive-policy signature can never be replayed as a different signed
 * artifact (an announce, a future policy-v2 envelope, …).
 */
export const HIVE_POLICY_SIG_DOMAIN = 'papercusp-hive-policy-v1';

/**
 * Recursively sort object keys so a parsed policy has ONE canonical serialization
 * regardless of insertion / jsonb / wire key order. Arrays preserve order (it is part
 * of the signed content). Primitives pass through. The result feeds JSON.stringify.
 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeysDeep(o[k]);
    return out;
  }
  return v;
}

/**
 * The CANONICAL JSON string of a policy object — deterministic (sorted keys, no
 * whitespace), single-line (JSON.stringify escapes any embedded newline as `\n`), and
 * stable across a parse→canonicalize round trip for our value space (strings, ints,
 * bools, string arrays, nested objects). This is what is STORED in `policy_json` and
 * what the signature covers. Computed over the WHOLE object so unknown keys are signed.
 */
export function canonicalizeHivePolicy(policy: HivePolicy | Record<string, unknown> | null | undefined): string {
  return JSON.stringify(sortKeysDeep(policy ?? {}));
}

/**
 * The EXACT bytes the owner signs and a member verifies. Newline-delimited and
 * unambiguous: the domain tag + workspaceId + hiveHomeSlug + policyVersion can contain
 * no newline (slugs/ids are newline-free, the version is an int), and `canonicalPolicyJson`
 * is single-line canonical JSON. Binding workspace + slug + version into the signed
 * message prevents cross-Hive / cross-version signature replay.
 */
export function hivePolicySignedBytes(input: {
  workspaceId: string;
  hiveHomeSlug: string;
  policyVersion: number;
  /** The canonical policy JSON string (the value stored in `policy_json`). */
  canonicalPolicyJson: string;
}): Buffer {
  const msg = [
    HIVE_POLICY_SIG_DOMAIN,
    input.workspaceId,
    input.hiveHomeSlug,
    String(input.policyVersion),
    input.canonicalPolicyJson,
  ].join('\n');
  return Buffer.from(msg, 'utf8');
}

const MEMBERSHIP_MODES: ReadonlySet<string> = new Set(['open', 'approval', 'allowlist']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate + accept an UNTRUSTED policy input (the authoring API body). Forward-compatible
 * by design: it checks the SHAPE of the known fields when present and otherwise PRESERVES
 * unknown keys (so a newer client's field round-trips + gets signed). Rejects only what is
 * structurally wrong for a known field — never an unknown key. Returns the policy unchanged
 * on success (it is signed verbatim). Used by the route + the tests.
 */
export function coerceHivePolicyInput(
  raw: unknown,
): { ok: true; policy: HivePolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'policy must be a JSON object' };
  }
  const p = raw as Record<string, unknown>;
  if (p.rate !== undefined) {
    if (!p.rate || typeof p.rate !== 'object' || Array.isArray(p.rate)) {
      return { ok: false, error: 'policy.rate must be an object' };
    }
    const r = p.rate as Record<string, unknown>;
    for (const k of ['opsPerMin', 'rowsPerHour', 'prsPerDay'] as const) {
      if (r[k] !== undefined && (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || (r[k] as number) < 0)) {
        return { ok: false, error: `policy.rate.${k} must be a non-negative number` };
      }
    }
  }
  if (p.membership !== undefined && !MEMBERSHIP_MODES.has(p.membership as string)) {
    return { ok: false, error: "policy.membership must be 'open' | 'approval' | 'allowlist'" };
  }
  if (
    p.contentWriteAuthority !== undefined &&
    p.contentWriteAuthority !== 'member' &&
    p.contentWriteAuthority !== 'author-scoped'
  ) {
    return { ok: false, error: "policy.contentWriteAuthority must be 'member' | 'author-scoped'" };
  }
  if (p.allowlist !== undefined && !isStringArray(p.allowlist)) {
    return { ok: false, error: 'policy.allowlist must be a string[]' };
  }
  if (p.moderation !== undefined) {
    if (!p.moderation || typeof p.moderation !== 'object' || Array.isArray(p.moderation)) {
      return { ok: false, error: 'policy.moderation must be an object' };
    }
    const m = p.moderation as Record<string, unknown>;
    if (m.reportable !== undefined && typeof m.reportable !== 'boolean') {
      return { ok: false, error: 'policy.moderation.reportable must be a boolean' };
    }
    if (m.bannedGithubIds !== undefined && !isStringArray(m.bannedGithubIds)) {
      return { ok: false, error: 'policy.moderation.bannedGithubIds must be a string[]' };
    }
    if (m.takedownList !== undefined && !isStringArray(m.takedownList)) {
      return { ok: false, error: 'policy.moderation.takedownList must be a string[]' };
    }
  }
  return { ok: true, policy: p as HivePolicy };
}

/**
 * Parse a stored `policy_json` TEXT into the typed view. Defensive: a malformed /
 * non-object value returns an empty policy `{}` (permissive) rather than throwing —
 * the read path must never crash on a junk row, and the signature check at apply
 * already rejected anything forged before it could be stored.
 */
export function parseHivePolicyJson(policyJson: string | null | undefined): HivePolicy {
  if (!policyJson) return {};
  try {
    const v = JSON.parse(policyJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HivePolicy) : {};
  } catch {
    return {};
  }
}
