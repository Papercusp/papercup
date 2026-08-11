/**
 * The seed's table-exclusion POLICY, in a module with NO dependencies.
 *
 * ── WHY THIS IS ITS OWN FILE ──
 * Two very different layers need this list, and they must not be able to drift:
 *   • `seed-provider-corestore.ts` — the cut itself (mint + the shipped-suffix guard).
 *   • `boot.ts` — the LIVE operator, which is what actually appends the head snapshot a
 *     no-outage cut ships (it holds the corestore write lock, so the cutter cannot).
 * `boot.ts` imports `corestore` as a TYPE ONLY. Importing the seed provider just to
 * reach this constant would add a real runtime dependency on `corestore` +
 * `@papercusp/seed-bundle` to the substrate boot path — every desktop launch pays it —
 * and would invert the layering (boot ← seed provider). A dependency-free constants
 * module is the seam that lets both sides share ONE list.
 *
 * `seed-provider-corestore.ts` re-exports this, so existing importers and tests that
 * reach for `SEED_EXCLUDED_TABLES` there are unaffected.
 */

/**
 * Tables cut OUT of the shipped seed (EI-20108164746219771).
 *
 * `presence` is heartbeat state keyed `<github_user_id>/<machine_label>`, carrying the
 * build box's machine label into every published SERVER installer. It is RUNTIME state
 * re-announced on a keep-alive every `DEFAULT_REFRESH_MS` (30s — presence-announce.ts),
 * so dropping it costs a joiner at most one heartbeat of staleness.
 *
 * ⚠ That 30s keep-alive is the ENTIRE justification for filtering a table out of a
 * snapshot appended to the owner's LIVE log. Readers fold FORWARD from the newest
 * complete snapshot, so a row omitted from it is unreachable for anyone who seeds from
 * that snapshot — for `presence` that is a self-healing staleness window, but for a
 * table with real history it is silent DATA LOSS. Do not add a table here without
 * establishing that something regenerates its rows.
 *
 * ⚠ `usage` IS DELIBERATELY **NOT** HERE, and an earlier revision of this constant had
 * it — wrongly. The first census reported "usage=3 identity-bearing", but that probe
 * matched FIELD NAMES (a key literally called `device_pubkey`), not the owner's identity.
 * Re-measured against the release gate's OWN denylist, `usage` carries ZERO identity
 * values. It is also `contributor_usage_events`: an append-only, federated ledger that
 * is the source of truth for tier-C contributor stats. Excluding it would have discarded
 * 1517 legitimate ledger rows to remove nothing — and, per the paragraph above, would
 * have destroyed them in the owner's live log too.
 * ⚠ DELIBERATELY NOT `hive-members` (the membership ROSTER — required, owner-authorised)
 * and NOT `NEVER_RATE_LIMITED_TABLE_TAGS` (it also holds contributors / hive-members /
 * hive-settings, all of which the seed REQUIRES).
 *
 * ⛔ TABLE-LEVEL EXCLUSION IS NOT THE WHOLE FIX. The same corrected census found identity
 * inside two tables that CANNOT be dropped because they are required content:
 *   hive-members  → value paths `github_username`, `device_attestations[].device_label`
 *   hive-policy   → value path `policy_json`
 * Those need a field-level decision (scrub the device label; the owner's handle in the
 * roster is plausibly intended and owner-authorised), NOT another entry here. Tracked on
 * the item — do not "finish" this fix by widening this list.
 */
export const SEED_EXCLUDED_TABLES: readonly string[] = ['presence'];
