/**
 * P-008 of plan `review-routing-through-relevance-router-2026-09-26`, clause
 * RR-P-008-direct-recruit-guard.
 *
 * D-001 of that plan: every review (acceptance grading, rubric vetting,
 * grading-integrity audits, second vetting critics, BAR-amendment approval) is
 * recruited through the relevance router. No agent-facing instruction may tell
 * the reader to hand-pick a reviewer and recruit it directly: by message
 * (`coord:send` / `coord:message-agent` / `coord:handoff`), by dispatch
 * (`coord:dispatch`), by picking one off `coord:presence`, or by minting an
 * assigned work-item (`assign_to`). The routed doors are
 * `plans:set-plan-status → shipped` (grading), `consult:get_feedback
 * { policy:'rubric-vetting' }` (vetting) and `scorecards:repair` (a stalled
 * audit).
 *
 * The guard scans the agent-facing corpus: agent-insights docs, operator role
 * prompts, harness blueprint prompts, and every string literal in
 * `packages/operator-core/lib` source (remedy text, refusal payloads, tool
 * guidance). A sentence is a violation when it names a review role AND a
 * direct-recruit mechanism, and does not negate it ("never coord:send a grader").
 *
 * Fixture-control discipline (CLAUDE.md "module you import" tier): planted
 * violating instructions MUST be flagged, correct routed instructions MUST NOT,
 * the corpus has a size floor so an empty `git ls-files` cannot pass vacuously,
 * and the allowlist is shrink-only — an entry that stops matching fails here so
 * it gets deleted rather than silently widening the exemption.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ROOT } from './corpus-subject';

// Bare "review(s)" is deliberately absent: it matched "queued for owner review"
// and feedback replies ("Review it and … coord:send feedback"), none of which
// recruit a reviewer. The role nouns and the verb "grade" carry the signal.
const REVIEW = /\b(grade[sd]?|graders?|grading|critics?|reviewers?|approvers?|auditors?|vetting|vet the rubric|grading-integrity|second opinion)\b/i;
const RECRUIT = /(coord:send|coord:dispatch|coord:message-agent|coord:handoff|coord_send|coord_dispatch|\bassign_to\b|coord:presence)/;
const PHRASE = /\b(have|ask|get|find|pick) (a|another) live (non-implementer|session|peer|agent)\b/i;
/**
 * An imperative that recruits by hand without naming a tool ("Dispatch the
 * grading audit to …"). The verb must take a review OBJECT: a bare leading
 * "Wake —" in a system description recruits nobody.
 */
const IMPERATIVE = /^(?:then |and |next,? )?(?:dispatch|message|ping|wake|hand-?pick|assign)\b[^.;]{0,40}?\b(?:a|an|another|the|that|this|your)\s+(?:(?:live|eligible|independent|second|non-implementer|fresh)\s+)*(?:graders?|reviewers?|critics?|auditors?|approvers?|review|audit|grading)\b/i;
const NEGATED = /\b(never|do not|don't|not a way|no longer|instead of|rather than|not by|was the old|refused)\b/i;

export function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/)
    .flatMap((p) => p.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+(?=[A-Z`*(])/))
    .map((s) => s.replace(/^(?:[-*]|\d+\.)\s+/, '').trim())
    .filter(Boolean);
}

export function recruitViolations(text: string): string[] {
  return sentences(text).filter(
    (s) => (RECRUIT.test(s) || PHRASE.test(s) || IMPERATIVE.test(s.replace(/^[`*_]+/, ''))) && REVIEW.test(s) && !NEGATED.test(s),
  );
}

/**
 * Every string an agent can read out of a TS source: string and template
 * literals, with `+` concatenations re-joined so a sentence split across
 * operands is judged whole. Comments are not agent-facing and are skipped.
 */
export function agentFacingStrings(source: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const lit = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => ` X ${s.literal.text}`).join('');
    return null;
  };
  const isPlus = (n: ts.Node | undefined): n is ts.BinaryExpression =>
    !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const flatten = (n: ts.Node): string => {
    if (isPlus(n)) return flatten(n.left) + flatten(n.right);
    if (ts.isParenthesizedExpression(n)) return flatten(n.expression);
    return lit(n) ?? ' X ';
  };
  const visit = (n: ts.Node): void => {
    if (isPlus(n) && !isPlus(n.parent) && !(n.parent && ts.isParenthesizedExpression(n.parent) && isPlus(n.parent.parent))) {
      out.push(flatten(n));
      return;
    }
    if (!isPlus(n.parent)) {
      const l = lit(n);
      if (l !== null) {
        out.push(l);
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((s) => visit(s.expression));
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface CorpusFile { path: string; kind: 'text' | 'ts'; read: () => string }
interface Hit { path: string; sentence: string }

/**
 * A query string is not agent-facing: its `-- …` comments (goal-owner-report-
 * watchdog.ts explains a `coord:send` join next to "the graded holder") are
 * read by Postgres, never by an agent.
 */
export const looksLikeSql = (s: string): boolean =>
  (s.match(/\b(SELECT|FROM|WHERE|JOIN|LATERAL|NULLIF|COALESCE|INSERT INTO)\b/g) ?? []).length >= 2;

export function scan(files: readonly CorpusFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    const body = f.read();
    const texts = f.kind === 'text'
      ? [body]
      : RECRUIT.test(body) || PHRASE.test(body) || /\b(dispatch|hand-?pick)\b/i.test(body)
        ? agentFacingStrings(body, f.path).filter((s) => !looksLikeSql(s))
        : [];
    for (const t of texts) for (const sentence of recruitViolations(t)) hits.push({ path: f.path, sentence });
  }
  return hits;
}

/**
 * Sentences that match the pattern but are NOT review recruiting. Each needs a
 * reason; `match` is a substring of the flagged sentence. Shrink-only: a stale
 * entry fails the last test below.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; match: string; reason: string }> = [
  {
    path: 'apps/operator/prompts/papercusp-su-power.tools.md',
    match: 'hand-off is `coord:send`',
    reason: 'feature-pipeline stage hand-off between pipeline roles; the pipeline assigns the reviewer, the reader does not pick one',
  },
  {
    path: 'apps/operator/prompts/worker.tools.md',
    match: 'addressed to the orchestrator + reviewer',
    reason: 'a worker REPORTS its change to the reviewer the pipeline already assigned; it recruits nobody',
  },
  {
    path: 'packages/operator-core/lib/scout/feedback-loop-prompt.ts',
    match: 'ready for re-review',
    reason: 'replies to the reviewer whose feedback woke the scout (an existing thread), not recruitment of a new reviewer',
  },
  {
    path: 'packages/operator-core/lib/scout/ratification-gate.ts',
    match: 'Route it to a DIFFERENT steward',
    reason:
      'scout draft-plan ratification by a GRADE/GOAL-mode steward is outside D-001\'s enumerated review set (acceptance grading, rubric vetting, grading-integrity audits, second vetting critics, BAR amendment approval); whether it moves under the router is tracked as WI-10003217 — delete this entry when it does',
  },
];

const allowed = (h: Hit) => ALLOWLIST.some((a) => a.path === h.path && h.sentence.includes(a.match));

function lsFiles(prefix: string, cwd = ROOT): string[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(Boolean);
}

function liveCorpus(): { files: CorpusFile[]; counts: Record<string, number> } {
  const text = (p: string): CorpusFile => ({ path: p, kind: 'text', read: () => readFileSync(join(ROOT, p), 'utf8') });
  const docs = lsFiles('apps/operator-docs/src/content/docs/agent-insights/').filter((f) => f.endsWith('.mdx'));
  const prompts = lsFiles('apps/operator/prompts/').filter((f) => f.endsWith('.md'));
  // `git ls-files` is submodule-blind from the superproject: list the
  // blueprint prompts from INSIDE libs/papercusp, then re-prefix.
  const blueprints = lsFiles('packages/harness/blueprints/', join(ROOT, 'libs/papercusp'))
    .filter((f) => /\/prompts\/.*\.md$/.test(f))
    .map((f) => `libs/papercusp/${f}`);
  const code = lsFiles('packages/operator-core/lib/').filter(
    (f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$|\.d\.ts$|__tests__|\/fixtures?\//.test(f),
  );
  // Falsifiability seam (CLAUDE.md tier 2/historical): scripts/mutation-probe.sh
  // points this at a copied or historical snapshot of a corpus file, so the
  // guard can be shown to FAIL without mutating the shared tree.
  const extra = process.env.RR_GUARD_EXTRA_FILE;
  const extraFiles: CorpusFile[] = extra
    ? [{ path: extra, kind: process.env.RR_GUARD_EXTRA_KIND === 'text' ? 'text' : 'ts', read: () => readFileSync(extra, 'utf8') }]
    : [];
  return {
    files: [
      ...extraFiles,
      ...[...docs, ...prompts, ...blueprints].map(text),
      ...code.map((p): CorpusFile => ({ path: p, kind: 'ts', read: () => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } } })),
    ],
    counts: { docs: docs.length, prompts: prompts.length, blueprints: blueprints.length, code: code.length },
  };
}

describe('review recruiting routes through the relevance router (D-001)', () => {
  const PLANTED = [
    'Ask a live non-implementer to grade the plan; coord:send them the rubric ref.',
    'Pick a reviewer from coord:presence and coord:dispatch the grading request to them.',
    'File a work_items:create grading request with assign_to set to the reviewer.',
    'Send the rubric to a second vetting critic via coord:send expects:action.',
    'Dispatch the grading-integrity audit to an eligible auditor.',
    'Have a live peer approve the BAR amendment: coord:message-agent the approver.',
  ];

  it.each(PLANTED)('flags a planted direct-recruit instruction: %s', (planted) => {
    expect(recruitViolations(planted)).toEqual([planted]);
  });

  it.each([
    'Call plans:set-plan-status { status:"shipped" }: it routes the plan to a lineage-independent grader.',
    'Never coord:send a grader directly; the ship verb is the recruiter.',
    'Do not pick a grader yourself: retry plans:set-plan-status after the grace window.',
    'Vet the rubric with consult:get_feedback { policy:"rubric-vetting" }.',
    'coord:send the owner a status report.', // recruiting, but not a review
  ])('passes a routed or unrelated instruction: %s', (ok) => {
    expect(recruitViolations(ok)).toEqual([]);
  });

  it('reads TS string literals (template + concatenation), not comments', () => {
    const source = [
      '// coord:send a grader — a comment, invisible to agents',
      'const a = `Ask a live non-implementer to grade ${slug}: coord:send them.`;',
      "const b = 'Pick a reviewer and ' + 'coord:dispatch the review.';",
      "const c = 'Call plans:set-plan-status to recruit a grader.';",
      "const q = `SELECT 1 FROM t -- a coord:send to the graded holder\n WHERE x`;",
    ].join('\n');
    const hits = scan([{ path: 'planted.ts', kind: 'ts', read: () => source }]);
    expect(hits.map((h) => h.sentence)).toEqual([
      'Ask a live non-implementer to grade X : coord:send them.',
      'Pick a reviewer and coord:dispatch the review.',
    ]);
  });

  const corpus = liveCorpus();

  it('scans a non-trivial corpus (vacuity floor)', () => {
    expect(corpus.counts.docs).toBeGreaterThan(300);
    expect(corpus.counts.prompts).toBeGreaterThan(20);
    expect(corpus.counts.blueprints).toBeGreaterThan(20);
    expect(corpus.counts.code).toBeGreaterThan(2000);
  });

  it('a direct-recruit instruction planted into the live corpus scan is reported', () => {
    const planted: CorpusFile = { path: 'apps/operator/prompts/planted.tools.md', kind: 'text', read: () => `# Planted\n\n${PLANTED[0]}\n` };
    const hits = scan([...corpus.files, planted]).filter((h) => !allowed(h));
    expect(hits).toEqual([{ path: planted.path, sentence: PLANTED[0] }]);
  }, 60_000);

  it('the current docs, prompts and source recommend no direct review recruiting', () => {
    const hits = scan(corpus.files);
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
    // Shrink-only: every allowlist entry must still match a live sentence.
    for (const entry of ALLOWLIST) {
      expect(hits.some((h) => h.path === entry.path && h.sentence.includes(entry.match)), `stale allowlist entry: ${entry.path}`).toBe(true);
    }
  }, 60_000);
});
