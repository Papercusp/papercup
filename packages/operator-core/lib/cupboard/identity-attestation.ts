/**
 * Publisher-side P-003 attestation for identity documents (identities-v1 D-124).
 *
 * An INSTALLED identity layer must carry `attestation: { contentHash, signedBy }`
 * whose `contentHash` equals `layerContentHash(raw)` — the sha256 over the document
 * with `attestation` itself excluded, so the embedded block cannot invalidate
 * itself. `identity-lint` refuses an installed identity without one
 * (`attestation-missing`), which is what every identity management surface reads.
 *
 * The block is stamped where the PUBLISHED bytes are produced (the official mirror
 * sync), never in the monorepo source: the built-in tree is edited continuously, and
 * a stale block there would fail `resolveBlueprint`'s declared-attestation check on
 * the built-in tier. The Cupboard listing signature then covers the package bytes
 * that carry the block, so the in-document attestation is transitively signed.
 *
 * Non-identity documents (no own `slots`) are returned untouched: P-003 only
 * requires installed IDENTITY layers to attest.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { layerContentHash, parseBlueprintSourceDocument } from '@papercusp/orchestrator/blueprint';
import { parseDocument } from 'yaml';

/** The Cupboard publisher login that signs the official blueprint listings. */
export const OFFICIAL_BLUEPRINT_PUBLISHER = 'papercupai';

export interface IdentityAttestationStamp {
  /** The document text to publish (unchanged when `stamped` is false). */
  text: string;
  /** True when the input was an identity document and now carries the attestation. */
  stamped: boolean;
  /** `layerContentHash` of the document, or null for a non-identity document. */
  contentHash: string | null;
}

/**
 * Stamp (or re-stamp) the P-003 attestation onto one blueprint.yaml text.
 * Idempotent: a document already carrying the correct block is returned byte-identical.
 * Comments and key order are preserved (the yaml Document API), and the block is
 * appended as the last top-level key so an existing document's layout is undisturbed.
 */
export function stampIdentityAttestation(text: string, signedBy: string): IdentityAttestationStamp {
  const publisher = signedBy.trim();
  if (!publisher) throw new Error('stampIdentityAttestation: signedBy is required');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`stampIdentityAttestation: unparseable yaml: ${doc.errors.map((e) => e.message).join('; ')}`);
  }
  const raw = doc.toJS() as Record<string, unknown>;
  if (parseBlueprintSourceDocument(raw).kind !== 'identity') {
    return { text, stamped: false, contentHash: null };
  }
  const contentHash = layerContentHash(raw);
  const current = raw.attestation as { contentHash?: unknown; signedBy?: unknown } | undefined;
  if (current?.contentHash === contentHash && current?.signedBy === publisher) {
    return { text, stamped: true, contentHash };
  }
  if (doc.has('attestation')) doc.delete('attestation');
  doc.set('attestation', doc.createNode({ contentHash, signedBy: publisher }));
  return { text: doc.toString(), stamped: true, contentHash };
}

/** Prepare the exact first-party metadata transition to the portable identity
 * root. This never edits an installed package or relaxes the source schema.
 * The caller previews and commits the resulting package through the release
 * lifecycle, retaining the original release and guarding the active bytes. */
export function prepareOfficialIdentityMetadataTransition(
  installedText: string,
  builtinText: string,
): IdentityAttestationStamp {
  const installed = parseDocument(installedText);
  const builtin = parseDocument(builtinText);
  if (installed.errors.length || builtin.errors.length) {
    throw new Error('official identity metadata transition: invalid YAML');
  }
  const prior = installed.toJS() as Record<string, unknown> | null;
  const current = builtin.toJS() as Record<string, unknown> | null;
  if (!prior || !current || Array.isArray(prior) || Array.isArray(current) ||
      parseBlueprintSourceDocument(current).kind !== 'identity' ||
      current.extends !== 'identity-root' || 'mode' in current ||
      prior.extends !== 'base' || prior.visibility !== 'public') {
    throw new Error('official identity metadata transition: unsupported legacy metadata');
  }
  const attestation = prior.attestation as { contentHash?: unknown; signedBy?: unknown } | undefined;
  if (attestation?.signedBy !== OFFICIAL_BLUEPRINT_PUBLISHER ||
      attestation.contentHash !== layerContentHash(prior)) {
    throw new Error('official identity metadata transition: invalid prior official attestation');
  }
  const normalized = { ...prior, extends: 'identity-root' };
  delete (normalized as Record<string, unknown>).visibility;
  delete (normalized as Record<string, unknown>).attestation;
  const expected = { ...current };
  delete expected.attestation;
  if (!isDeepStrictEqual(normalized, expected)) {
    throw new Error('official identity metadata transition: installed semantics differ from the builtin');
  }
  installed.delete('visibility');
  installed.set('extends', 'identity-root');
  installed.delete('attestation');
  return stampIdentityAttestation(installed.toString(), OFFICIAL_BLUEPRINT_PUBLISHER);
}

/**
 * Stamp every identity document under `<mirrorRoot>/<id>/blueprint.yaml` in place —
 * the step the official mirror sync runs on its COPY, after mirroring and before
 * commit/push. Returns the ids that are identities (stamped); others are untouched.
 */
export function stampMirrorIdentityAttestations(
  mirrorRoot: string,
  ids: readonly string[],
  signedBy: string = OFFICIAL_BLUEPRINT_PUBLISHER,
): { id: string; contentHash: string }[] {
  const stamped: { id: string; contentHash: string }[] = [];
  for (const id of ids) {
    const file = join(mirrorRoot, id, 'blueprint.yaml');
    if (!existsSync(file)) throw new Error(`stampMirrorIdentityAttestations: ${file} is missing`);
    const before = readFileSync(file, 'utf8');
    const result = stampIdentityAttestation(before, signedBy);
    if (!result.stamped || !result.contentHash) continue;
    if (result.text !== before) writeFileSync(file, result.text);
    stamped.push({ id, contentHash: result.contentHash });
  }
  return stamped;
}
