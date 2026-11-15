import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  codeIntelCommentarySchema, isTrustworthyEmpty, versionedSymbolIdentity,
  type CodeIntelAnswer, type CodeIntelCommentary,
} from './contracts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text).length;
const copy = <T>(value: T): T => structuredClone(value);

function observation(language: 'typescript' | 'javascript' | 'rust', signatureOnly = false): CodeIntelCommentary {
  const rust = language === 'rust';
  const path = `src/counter.${rust ? 'rs' : language === 'javascript' ? 'js' : 'ts'}`;
  const member = rust && signatureOnly;
  const prefix = '// café 😀\n' + (member ? 'trait API {\n' : '');
  const raw = rust ? '/// Adds one. Résumé 😀\n/// See [`Counter`].' : '/** Adds one. Résumé 😀\n * @see Counter\n */';
  const declaration = rust ? (member ? 'fn increment(input: i32) -> i32;' : 'fn increment(input: i32) -> i32 { input + 1 }')
    : `function increment(input${language === 'typescript' ? ': number' : ''}) { return input + 1; }`;
  const content = prefix + raw + '\n' + declaration + (member ? '\n}' : '');
  const file = { path, contentHash: digest(content), language, representation: 'full-source' as const };
  const site = { path, line1: (prefix + raw + '\n').split('\n').length,
    kind: member ? 'method' : 'function', name: 'increment' };
  const locator = { container: member ? 'API' : null, kind: site.kind, name: 'increment', signatureSelector: null };
  const adapter = { id: `native-${language}`, version: '1',
    parser: { id: 'maintained-structural-facade', version: '1' },
    normalization: { id: 'documentation-fingerprint-v1', version: '1' }, certifiedForms: ['function'] };
  const subject = {
    canonicalRevision: { kind: 'source-comment' as const, commentDigest: digest('Adds one. See Counter.') },
    declaration: { ...locator, repositoryId: 'repo-a', language },
    signatureDigest: digest(`${language}:increment(input)`),
    body: member ? { kind: 'absent' as const, reason: 'signature-only trait member' }
      : { kind: 'present' as const, digest: digest('input + 1') },
    commentDigest: digest('Adds one. See Counter.'), dependencySnapshotDigest: digest('declared:[]'),
    adapter: { id: adapter.id, version: adapter.version }, normalization: adapter.normalization,
  };
  return {
    schemaVersion: 1, source: { repositoryId: 'repo-a', identityKind: 'registry', file, byteLength: bytes(content) },
    adapter, outcome: 'found', sourceCompleteness: 'unverified', reasons: [],
    units: [{
      canonicalHome: { kind: 'source-comment', repositoryId: 'repo-a', path }, locator, form: 'function',
      association: { status: 'attached', reason: null },
      declaration: { site, contentHash: file.contentHash, versionedSymbolId: versionedSymbolIdentity('repo-a', site, file) },
      ranges: [{ encoding: 'utf8-bytes', startByte0: bytes(prefix), endByte0: bytes(prefix + raw),
        startLine1: prefix.split('\n').length, endLine1: (prefix + raw).split('\n').length, raw }],
      sections: [{ kind: 'summary', name: null, text: 'Adds one. Résumé 😀', rangeIndices: [0] }],
      references: [{ kind: 'see', target: 'Counter', rangeIndices: [0] }],
      nativeExtensions: rust ? { rust: { style: 'outer-line-doc', attributes: ['#[doc = r"literal // text"]'] } }
        : { [language]: { style: 'jsdoc', tags: ['@see Counter'] } },
      currentSubject: subject,
      review: { status: 'untracked', binding: null, approvedSubject: null,
        evidenceRefs: [], reviewedSource: null, currentResolutionRef: null },
    }],
  };
}

function freshObservation(): CodeIntelCommentary {
  const value = copy(observation('rust'));
  value.units[0]!.review = { status: 'fresh',
    binding: { id: '00000000-0000-4000-8000-000000000001', revision: 1 },
    approvedSubject: copy(value.units[0]!.currentSubject), evidenceRefs: ['review:exact-subject'],
    reviewedSource: copy(value.source!.file), currentResolutionRef: null };
  return value;
}

describe('language-neutral commentary contract', () => {
  it.each(['typescript', 'javascript', 'rust'] as const)('retains equivalent field meanings and native data for %s', language => {
    const input = observation(language);
    const value = codeIntelCommentarySchema.parse(JSON.parse(JSON.stringify(input)));
    expect(value).toEqual(input);
    expect(value.units[0]!.sections[0]).toMatchObject({ kind: 'summary', text: 'Adds one. Résumé 😀' });
    expect(value.units[0]!.references[0]!.target).toBe('Counter');
    expect(value.source!.file.language).toBe(language);
    expect(value.units[0]!.nativeExtensions).toHaveProperty(language);
  });

  it('preserves exact UTF-8 slices and rejects UTF-16 offsets, reversed spans and foreign source versions', () => {
    const input = observation('rust');
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(true);
    expect(input.units[0]!.ranges[0]!.startByte0).not.toBe('// café 😀\n'.length);
    const wrongEncoding = copy(input) as unknown as Record<string, unknown>;
    (wrongEncoding.units as CodeIntelCommentary['units'])[0]!.ranges[0]!.encoding = 'utf16' as never;
    expect(codeIntelCommentarySchema.safeParse(wrongEncoding).success).toBe(false);
    const utf16Span = copy(input);
    utf16Span.units[0]!.ranges[0]!.endByte0 = utf16Span.units[0]!.ranges[0]!.startByte0
      + utf16Span.units[0]!.ranges[0]!.raw.length;
    expect(codeIntelCommentarySchema.safeParse(utf16Span).success).toBe(false);
    const reversed = copy(input);
    reversed.units[0]!.ranges[0]!.endByte0 = reversed.units[0]!.ranges[0]!.startByte0 - 1;
    expect(codeIntelCommentarySchema.safeParse(reversed).success).toBe(false);
    const foreign = copy(input);
    foreign.units[0]!.declaration!.contentHash = digest('a different source version');
    expect(codeIntelCommentarySchema.safeParse(foreign).success).toBe(false);
    const staleIdentity = copy(input);
    staleIdentity.units[0]!.declaration!.versionedSymbolId = 'unresolved-old-location';
    expect(codeIntelCommentarySchema.safeParse(staleIdentity).success).toBe(false);
  });

  it('rejects out-of-bounds, overlapping or unretained source ranges', () => {
    const input = observation('typescript');
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(true);
    const outside = copy(input);
    outside.source!.byteLength = outside.units[0]!.ranges[0]!.endByte0 - 1;
    expect(codeIntelCommentarySchema.safeParse(outside).success).toBe(false);
    const overlap = copy(input);
    overlap.units[0]!.ranges = [overlap.units[0]!.ranges[0]!, copy(overlap.units[0]!.ranges[0]!)];
    expect(codeIntelCommentarySchema.safeParse(overlap).success).toBe(false);
    const absent = copy(input);
    absent.units[0]!.sections[0]!.rangeIndices = [1];
    expect(codeIntelCommentarySchema.safeParse(absent).success).toBe(false);
  });

  it('retains unsupported and ambiguous units without certifying an empty or attached result', () => {
    const unsupported = copy(observation('rust'));
    unsupported.outcome = 'unsupported'; unsupported.reasons = ['computed doc attribute'];
    unsupported.units[0]!.association = { status: 'unsupported', reason: 'include_str! requires expansion evidence' };
    unsupported.units[0]!.declaration = null;
    unsupported.units[0]!.currentSubject = null;
    expect(codeIntelCommentarySchema.parse(unsupported).units[0]!.association.status).toBe('unsupported');
    const fabricated = copy(unsupported);
    fabricated.outcome = 'found';
    expect(codeIntelCommentarySchema.safeParse(fabricated).success).toBe(false);
    const ambiguous = copy(unsupported);
    ambiguous.outcome = 'incomplete'; ambiguous.reasons = ['multiple declaration candidates'];
    ambiguous.units[0]!.association = { status: 'ambiguous', reason: 'same method name in two containers' };
    expect(codeIntelCommentarySchema.safeParse(ambiguous).success).toBe(true);
    ambiguous.units[0]!.declaration = copy(observation('rust').units[0]!.declaration);
    expect(codeIntelCommentarySchema.safeParse(ambiguous).success).toBe(false);
  });

  it.each(['unassociated', 'ambiguous', 'unsupported', 'unknown'] as const)(
    'retains review history but rejects a current subject for an %s association', status => {
      const input = freshObservation();
      const unit = input.units[0]!;
      const previousSubject = copy(unit.currentSubject);
      const previousReview = copy(unit.review);
      input.outcome = 'incomplete'; input.reasons = ['declaration no longer resolves uniquely'];
      unit.association = { status, reason: 'declaration no longer resolves uniquely' };
      unit.declaration = null; unit.currentSubject = null; unit.review.status = 'unknown';
      const result = codeIntelCommentarySchema.parse(input);
      expect(result.units[0]!.currentSubject).toBeNull();
      expect(result.units[0]!.review).toEqual({ ...previousReview, status: 'unknown' });
      unit.currentSubject = previousSubject;
      const rejected = codeIntelCommentarySchema.safeParse(input);
      expect(rejected.success).toBe(false);
      if (!rejected.success) expect(rejected.error.issues).toContainEqual(expect.objectContaining({
        path: ['units', 0, 'currentSubject'],
        message: 'An unresolved declaration cannot identify a current review subject.',
      }));
    },
  );

  it('scopes an empty result to certified forms and preserves unavailable provenance as unknown', () => {
    const empty = copy(observation('javascript'));
    empty.units = []; empty.outcome = 'none-in-certified-scope';
    expect(codeIntelCommentarySchema.safeParse(empty).success).toBe(true);
    const uncertified = copy(empty); uncertified.adapter!.certifiedForms = [];
    expect(codeIntelCommentarySchema.safeParse(uncertified).success).toBe(false);
    const stub = copy(empty); stub.source!.file.representation = 'reexport-stub';
    expect(codeIntelCommentarySchema.safeParse(stub).success).toBe(false);
    const unknown = { ...empty, source: null, adapter: null, outcome: 'unknown', reasons: ['source unavailable'] };
    expect(codeIntelCommentarySchema.parse(unknown)).toMatchObject({ source: null, adapter: null, outcome: 'unknown' });
    expect(codeIntelCommentarySchema.safeParse({ ...unknown, reasons: [] }).success).toBe(false);
  });

  it('requires an explicit absent-body marker rather than inventing an empty implementation digest', () => {
    const input = copy(observation('rust', true));
    expect(codeIntelCommentarySchema.parse(input).units[0]!.currentSubject!.body).toEqual({
      kind: 'absent', reason: 'signature-only trait member',
    });
    input.units[0]!.currentSubject!.body = { kind: 'present', digest: '' };
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(false);
  });

  it('preserves old review history while requiring complete references and an unchanged subject for fresh', () => {
    const input = freshObservation();
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(true);
    const noBinding = copy(input); noBinding.units[0]!.review.binding = null;
    expect(codeIntelCommentarySchema.safeParse(noBinding).success).toBe(false);
    const noEvidence = copy(input); noEvidence.units[0]!.review.evidenceRefs = [];
    expect(codeIntelCommentarySchema.safeParse(noEvidence).success).toBe(false);
    const stub = copy(input); stub.units[0]!.review.reviewedSource!.representation = 'reexport-stub';
    expect(codeIntelCommentarySchema.safeParse(stub).success).toBe(false);
    const conflictingDigest = copy(input);
    if (conflictingDigest.units[0]!.currentSubject!.canonicalRevision.kind !== 'source-comment') throw new Error('fixture revision');
    conflictingDigest.units[0]!.currentSubject!.canonicalRevision.commentDigest = digest('a different canonical unit');
    expect(codeIntelCommentarySchema.safeParse(conflictingDigest).success).toBe(false);
    const changed = copy(input); changed.units[0]!.currentSubject!.body = { kind: 'present', digest: digest('input + 2') };
    expect(codeIntelCommentarySchema.safeParse(changed).success).toBe(false);
    changed.units[0]!.review.status = 'review';
    expect(codeIntelCommentarySchema.parse(changed).units[0]!.review.approvedSubject).toEqual(input.units[0]!.review.approvedSubject);
    const algorithm = copy(input); algorithm.adapter!.normalization.version = '2';
    expect(codeIntelCommentarySchema.safeParse(algorithm).success).toBe(false);
  });

  it('keeps observed source location separate from the semantic review subject after proven re-resolution', () => {
    const input = freshObservation(); const priorReview = copy(input.units[0]!.review);
    input.source!.file.path = 'src/moved.rs';
    const unit = input.units[0]!;
    if (unit.canonicalHome.kind !== 'source-comment') throw new Error('fixture home');
    unit.canonicalHome.path = input.source!.file.path;
    unit.declaration!.site.path = input.source!.file.path;
    unit.declaration!.versionedSymbolId = versionedSymbolIdentity('repo-a', unit.declaration!.site, input.source!.file);
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(false);
    unit.review.currentResolutionRef = 'resolution:unique-current-declaration';
    const result = codeIntelCommentarySchema.parse(input);
    expect(result.units[0]!.review.approvedSubject).toEqual(priorReview.approvedSubject);
    expect(result.units[0]!.review.reviewedSource).toEqual(priorReview.reviewedSource);
    expect(result.units[0]!.review.evidenceRefs).toEqual(priorReview.evidenceRefs);
    expect(result.units[0]!.review.reviewedSource!.path).not.toBe(result.source!.file.path);
  });

  it('has one canonical writable home and rejects a competing native prose authority', () => {
    const input = observation('typescript');
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(true);
    const duplicate = copy(input) as unknown as { units: { canonicalHome: Record<string, unknown> }[] };
    duplicate.units[0]!.canonicalHome.docId = 'competing-editable-copy';
    expect(codeIntelCommentarySchema.safeParse(duplicate).success).toBe(false);
    const foreign = copy(input);
    if (foreign.units[0]!.canonicalHome.kind !== 'source-comment') throw new Error('fixture home');
    foreign.units[0]!.canonicalHome.repositoryId = 'another-repository';
    expect(codeIntelCommentarySchema.safeParse(foreign).success).toBe(false);
  });

  it('keeps native extensions JSON-valued and keeps compiler/parser types behind the adapter boundary', () => {
    const input = observation('rust');
    expect(codeIntelCommentarySchema.safeParse(input).success).toBe(true);
    const callable = copy(input) as unknown as { units: { nativeExtensions: unknown }[] };
    callable.units[0]!.nativeExtensions = { node: { getText: () => 'compiler object' } };
    expect(codeIntelCommentarySchema.safeParse(callable).success).toBe(false);
    const source = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8');
    const imports = (text: string) => ts.createSourceFile('contracts.ts', text, ts.ScriptTarget.Latest, true).statements
      .filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text)
      .filter(name => /typescript|tree-sitter|ast-grep/.test(name));
    expect(imports(source)).toEqual([]);
    expect(imports(source + '\nimport type { Node } from "typescript";')).toEqual(['typescript']);
  });

  it('adds commentary without changing legacy answers or treating omission as a certified empty result', () => {
    const legacy: CodeIntelAnswer = { backend: 'first-party-snapshot', intent: 'symbol-search', query: 'increment',
      sites: [], truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null }, latencyMs: 1, error: null };
    expect(isTrustworthyEmpty(legacy)).toBe(true);
    expect(Object.hasOwn(legacy, 'commentary')).toBe(false);
    const joined: CodeIntelAnswer = { ...legacy, commentary: [codeIntelCommentarySchema.parse(observation('rust'))] };
    expect(joined.sites).toBe(legacy.sites);
    expect(joined.commentary![0]!.source!.file.language).toBe('rust');
    expect(Object.hasOwn(legacy, 'commentary')).toBe(false);
  });
});
