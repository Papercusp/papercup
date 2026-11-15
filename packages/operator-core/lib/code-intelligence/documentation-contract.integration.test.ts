/** Contract composition with real compiler evidence; fixture commentary is not adapter certification. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallers } from './first-party-callers';
import { codeIntelCommentarySchema, type CodeIntelAnswer, type CodeIntelCommentary } from './contracts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text).length;
const repositoryId = 'commentary-contract-integration';
const prefix = 'export function target() { return 1; }\n';
const raw = '/** Calls target. Résumé 😀 */';
const body = 'export function caller() { return target(); }\n';
const content = prefix + raw + '\n' + body;
let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'commentary-contract-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/control.ts'), content);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('commentary contract at the maintained compiler seam', () => {
  it('joins actual source identities and rejects an unresolved current subject while retaining review history', () => {
    const answer = firstPartyCallers({ ts, root, repositoryId, name: 'target' });
    expect(answer.error).toBeNull();
    expect(answer.sites).toHaveLength(1);
    const site = answer.sites[0]!;
    expect(site).toMatchObject({ path: 'src/control.ts', line1: 3 });
    const file = answer.evidence!.sourceScope.supportingFiles.find(file => file.path === site.path)!;
    expect(file.contentHash).toBe(hash(content));
    const versionedSymbolId = answer.evidence!.siteIdentities[0]!.versionedSymbolId;
    expect(versionedSymbolId).not.toBeNull();
    const locator = { container: null, kind: site.kind ?? 'function', name: site.name ?? null, signatureSelector: null };
    const adapter = { id: 'contract-fixture', version: '1',
      parser: { id: 'typescript', version: ts.version },
      normalization: { id: 'contract-fixture', version: '1' }, certifiedForms: [locator.kind] };
    const subject = {
      canonicalRevision: { kind: 'source-comment' as const, commentDigest: hash(raw) },
      declaration: { ...locator, repositoryId, language: file.language },
      signatureDigest: hash('caller()'), body: { kind: 'present' as const, digest: hash(body) },
      commentDigest: hash(raw), dependencySnapshotDigest: hash('target'),
      adapter: { id: adapter.id, version: adapter.version }, normalization: adapter.normalization,
    };
    const commentary: CodeIntelCommentary = {
      schemaVersion: 1, source: { repositoryId, identityKind: 'registry', file, byteLength: bytes(content) },
      adapter, outcome: 'found', sourceCompleteness: 'unverified', reasons: [],
      units: [{
        canonicalHome: { kind: 'source-comment', repositoryId, path: file.path },
        locator, form: locator.kind, association: { status: 'attached', reason: null },
        declaration: { site, contentHash: file.contentHash, versionedSymbolId },
        ranges: [{ encoding: 'utf8-bytes', startByte0: bytes(prefix), endByte0: bytes(prefix + raw),
          startLine1: 2, endLine1: 2, raw }],
        sections: [{ kind: 'summary', name: null, text: 'Calls target. Résumé 😀', rangeIndices: [0] }],
        references: [{ kind: 'symbol', target: 'target', rangeIndices: [0] }], nativeExtensions: {},
        currentSubject: subject,
        review: { status: 'fresh', binding: { id: '00000000-0000-4000-8000-000000000001', revision: 1 },
          approvedSubject: structuredClone(subject), evidenceRefs: ['review:fixture'],
          reviewedSource: structuredClone(file), currentResolutionRef: null },
      }],
    };
    const joined: CodeIntelAnswer = { ...answer, commentary: [codeIntelCommentarySchema.parse(commentary)] };
    expect(joined.evidence).toBe(answer.evidence);
    expect(joined.sites).toBe(answer.sites);
    expect(joined.commentary![0]!.units[0]!.declaration!.versionedSymbolId).toBe(versionedSymbolId);
    expect(Object.hasOwn(answer, 'commentary')).toBe(false);

    const previousReview = structuredClone(commentary.units[0]!.review);
    const unit = commentary.units[0]!;
    commentary.outcome = 'incomplete'; commentary.reasons = ['declaration association is ambiguous'];
    unit.association = { status: 'ambiguous', reason: commentary.reasons[0]! };
    unit.declaration = null; unit.currentSubject = null; unit.review.status = 'unknown';
    const unresolved = codeIntelCommentarySchema.parse(commentary);
    expect(unresolved.units[0]!.review).toEqual({ ...previousReview, status: 'unknown' });
    expect(unresolved.units[0]!.currentSubject).toBeNull();

    unit.currentSubject = subject;
    const fabricated = codeIntelCommentarySchema.safeParse(commentary);
    expect(fabricated.success).toBe(false);
    if (!fabricated.success) expect(fabricated.error.issues).toContainEqual(expect.objectContaining({
      path: ['units', 0, 'currentSubject'],
      message: 'An unresolved declaration cannot identify a current review subject.',
    }));
  }, 60_000);
});
