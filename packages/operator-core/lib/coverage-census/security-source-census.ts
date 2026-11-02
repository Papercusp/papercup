/** P-001 source discovery over the maintained pinned Git snapshot. Reuses the
 * source-path AST and runtime-compatibility inventory; never executes imports,
 * handlers or helpers. These are review leads, not a complete manifest or
 * evidence that a call's effects are contained. Missing/limited inputs survive
 * as gaps instead of silently shrinking the candidate population.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { censusSites, siteEvidence } from '../../../../scripts/lib/source-path-census.mjs';
import { inventorySources } from '../../../../scripts/lib/runtime-compatibility-census.mjs';

export interface PinnedSecuritySource {
  path: string; repository: string; commit: string; blobOid: string; bytes: Uint8Array;
}
export interface SecuritySourceSnapshot {
  sources: readonly PinnedSecuritySource[];
  repositories: readonly { path: string; commit: string }[];
  unresolved: readonly Record<string, unknown>[];
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonicalPath = (path: string) => !!path && !path.startsWith('/') && !path.includes('\\')
  && path.split('/').every(part => !!part && part !== '.' && part !== '..');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function enumerateSecuritySourcePopulation(snapshot: SecuritySourceSnapshot, limits: {
  maxFiles?: number; maxBytes?: number; maxInputBytes?: number; maxSites?: number;
} = {}) {
  const budget = { maxFiles: 50_000, maxBytes: 128 * 1024 * 1024,
    maxInputBytes: 2 * 1024 * 1024, maxSites: 500_000, ...limits };
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('security_source_positive_budget_required');
  }
  const unresolved: Record<string, unknown>[] = [...snapshot.unresolved];
  const selected: Array<Omit<PinnedSecuritySource, 'bytes'> & { bytes: Buffer }> = [];
  const seen = new Set<string>();
  const repositories = [...snapshot.repositories].sort((a, b) => compare(a.path, b.path));
  const pins = new Map<string, string>();
  for (const repository of repositories) {
    if (pins.has(repository.path)) throw new Error('security_source_duplicate_repository');
    if (repository.path !== '.' && !canonicalPath(repository.path)) throw new Error('security_source_invalid_repository');
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(repository.commit)) throw new Error('security_source_invalid_commit');
    pins.set(repository.path, repository.commit);
  }
  let bytesRead = 0;
  for (const source of [...snapshot.sources].sort((a, b) => compare(a.path, b.path))) {
    if (!canonicalPath(source.path)) throw new Error('security_source_noncanonical_path');
    if (seen.has(source.path)) throw new Error(`security_source_duplicate_path:${source.path}`);
    seen.add(source.path);
    if (pins.get(source.repository) !== source.commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.blobOid)
      || source.repository !== '.' && !source.path.startsWith(`${source.repository}/`)) {
      throw new Error(`security_source_pin_mismatch:${source.path}`);
    }
    const bytes = Buffer.from(source.bytes);
    const reason = bytes.length > budget.maxInputBytes ? 'source-input-budget'
      : selected.length >= budget.maxFiles ? 'source-file-budget'
      : bytesRead + bytes.length > budget.maxBytes ? 'source-byte-budget'
      : !Buffer.from(bytes.toString('utf8')).equals(bytes) ? 'source-not-utf8' : null;
    if (reason) {
      unresolved.push({ path: source.path, commit: source.commit, blobOid: source.blobOid, bytes: bytes.length, reason });
      continue;
    }
    const blob = createHash(source.blobOid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== source.blobOid) throw new Error(`security_source_blob_mismatch:${source.path}`);
    selected.push({ ...source, bytes }); bytesRead += bytes.length;
  }
  const inventory = inventorySources({ sources: selected, repositories, unresolved });
  const fileKinds = new Map(inventory.files.map(file => [file.path, file.sourceKind]));
  const sites: Array<ReturnType<typeof siteEvidence> & { fileSha256: string; sourceKind: string }> = [];
  for (const source of selected) {
    if (!/\.[cm]?[jt]sx?$/.test(source.path)) continue;
    try {
      const unit = censusSites(source.path, source.bytes.toString('utf8'));
      const sourceKind = fileKinds.get(source.path)!;
      const remaining = Math.max(0, budget.maxSites - sites.length);
      for (const site of unit.sites.slice(0, remaining)) {
        sites.push({ ...siteEvidence(site), fileSha256: unit.sha256, sourceKind });
      }
      if (unit.sites.length > remaining) inventory.unresolved.push({ path: source.path, reason: 'source-site-budget',
        omittedSites: unit.sites.length - remaining, firstOmittedByte: unit.sites[remaining].byteStart });
    } catch (error) {
      inventory.unresolved.push({ path: source.path, reason: 'source-site-parser-failed',
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  const body = { schema: 'papercusp-security-source-discovery-v1', budget, bytesRead,
    inventory, sites, closureAccepted: false as const, executionAdmitted: false as const };
  return { ...body, fingerprint: hash(canonicalJson(body)) };
}
