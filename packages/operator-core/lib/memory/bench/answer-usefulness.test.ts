/**
 * P-008 answer-usefulness tier: unit tests with an in-process fake LLM.
 *
 * The fake answers from whichever numbered source carries a FACT marker and
 * judges from the answer text, so every outcome below is known in advance.
 * The real `judgeRun` builds the judge prompt; only the transport is faked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LlmCallFn } from '@papercusp/testing-shell/llm';
import {
  ABSTAIN_TOKEN,
  ANSWER_CONTRACT,
  ANSWER_JUDGE_INSTRUCTIONS,
  ANSWER_JUDGE_MODEL,
  BlindingViolation,
  acceptJudgedScore,
  assertJudgeBlind,
  buildJudgeInputs,
  buildPassages,
  cohenKappa,
  loadArmReports,
  parseAnswer,
  runAnswerUsefulness,
  usableScores,
} from './answer-usefulness';

type Call = Parameters<LlmCallFn>[0];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-usefulness-'));
  dirs.push(d);
  return d;
}

const ENTRIES = [
  { key: 'memory:a', text: 'The deploy port is 3070. FACT-A', kind: 'fact' },
  // Mentions an arm name as ordinary corpus content: the blinding guard must tolerate it.
  { key: 'memory:b', text: 'Unrelated note: the gemma arm was benchmarked last week.', kind: 'fact' },
  { key: 'memory:c', text: 'The retry budget is 3 attempts. FACT-C', kind: 'fact' },
  { key: 'memory:d', text: 'Filler about lunch.', kind: 'fact' },
];
const GOLD = {
  memory: [
    { id: 'q1', class: 'exact-identifier', query: 'What port does deploy use?', expected: ['memory:a'], partition: 'test', group: 'g1' },
    { id: 'q2', class: 'lexical-gap', query: 'What is the retry budget?', expected: ['memory:c'], partition: 'test', group: 'g2' },
    { id: 'q3', class: 'hard-negative', query: 'What is the moon made of?', expected: [], partition: 'test', group: 'g3' },
    { id: 'cal', class: 'lexical-gap', query: 'calibration only', expected: ['memory:c'], partition: 'calibration', group: 'g4' },
  ],
  prose: [],
};
const PULL: Record<string, Record<string, string[]>> = {
  mdenseon: { q1: ['memory:b', 'memory:d'], q2: ['memory:c'], q3: ['memory:d'] },
  gemma: { q1: ['memory:a', 'memory:b'], q2: ['memory:c'], q3: [] },
};

function writeFixture(dir: string, opts: { synthetic?: boolean; names?: Record<string, string> } = {}) {
  const snapshot = path.join(dir, 'snapshot.json');
  const gold = path.join(dir, 'labels.json');
  fs.writeFileSync(snapshot, JSON.stringify({ formatVersion: 1, snapshotAt: '2026-10-06T00:00:00Z', seed: 's', suites: { memory: { entries: ENTRIES }, prose: { entries: [] } } }));
  fs.writeFileSync(gold, JSON.stringify(GOLD));
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const reports = Object.entries(PULL).map(([model, pulls]) => {
    const file = path.join(dir, `${opts.names?.[model] ?? `memory-${model}-v1`}.json`);
    fs.writeFileSync(file, JSON.stringify({
      runner: 'complete-hybrid-bench', model, corpus: 'memory',
      binding: { profileId: `profile-${model}`, schema: 'bench_shared', syntheticEmbedder: Boolean(opts.synthetic) },
      inputs: { snapshotSha256: sha(snapshot), goldSha256: sha(gold) },
      rows: GOLD.memory.filter((q) => q.partition === 'test').map((q) => ({ id: q.id, class: q.class, group: q.group, expected: q.expected,
        routes: { pull: { rankedKeys: pulls[q.id] } } })),
    }));
    return file;
  });
  return { snapshot, gold, reports };
}

function fakeLlm(calls: Call[]): LlmCallFn {
  return async (call) => {
    calls.push(call);
    const text = [call.system ?? '', ...call.messages.map((m) => m.content)].join('\n');
    if (call.model === ANSWER_CONTRACT.model) {
      const fact = [...text.matchAll(/\[(S\d+)\] [^\n]*FACT-/g)][0];
      const answer = fact ? `Answer from FACT [${fact[1]}]` : text.includes('moon') && text.includes('[S1]') ? 'It is cheese [S1]' : ABSTAIN_TOKEN;
      return { text: answer, inputTokens: 100, outputTokens: 10, costUsd: 0.001, raw: null };
    }
    expect(call.model).toBe(ANSWER_JUDGE_MODEL);
    const score = text.includes('Answer from FACT') ? [5, 5]
      : text.includes('It is cheese') ? [1, 1]
        : text.includes(ANSWER_JUDGE_INSTRUCTIONS.noReference) ? [5, 5] : [1, 5];
    const json = { summary: 's', scores: { correctness: score[0], grounding: score[1] }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] };
    return { text: JSON.stringify(json), json, inputTokens: 300, outputTokens: 40, costUsd: 0.004, raw: null };
  };
}

describe('answer parsing and passages', () => {
  it('detects declines, citations and citations to sources that were never shown', () => {
    expect(parseAnswer(`  ${ABSTAIN_TOKEN}  `, 2)).toEqual({ abstained: true, citedLabels: [], invalidCitations: [] });
    expect(parseAnswer('Port 3070 [S2], see also [S2] and [S7].', 3)).toEqual({ abstained: false, citedLabels: ['S2', 'S7'], invalidCitations: ['S7'] });
  });

  it('truncates context to the frozen k and character budget and refuses unknown keys', () => {
    const texts = new Map(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(5000)] as const));
    const passages = buildPassages([...texts.keys()], texts);
    expect(passages).toHaveLength(ANSWER_CONTRACT.k);
    expect(passages.every((p) => p.text.length === ANSWER_CONTRACT.passageChars)).toBe(true);
    expect(passages.map((p) => p.label)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(() => buildPassages(['missing'], texts)).toThrow(/not in the snapshot corpus/);
  });

  it('agreement statistics and score usability', () => {
    expect(cohenKappa([true, true, false, false], [true, true, false, false])).toBe(1);
    expect(cohenKappa([true, false, true, false], [false, true, false, true])).toBe(-1);
    expect(cohenKappa([], [])).toBeNull();
    expect(usableScores({ correctness: 4, grounding: 1 })).toBe(true);
    expect(usableScores({ correctness: 0, grounding: 5 })).toBe(false);
  });
});

describe('blinding (MDENSE-blinded-answer-score)', () => {
  const inputs = buildJudgeInputs('Which arm?', [{ label: 'S1', key: 'k', text: 'the gemma arm wrote this' }], [], 'gemma did it [S1]');

  it('tolerates arm names that occur only inside arm-independent content', () => {
    const request = { system: `Scenario\n${inputs.sources}\n${inputs.question}`, messages: [{ role: 'user' as const, content: `Transcript: ${inputs.answer}` }] };
    const attestation = assertJudgeBlind(request, inputs, ['gemma', 'mdenseon']);
    expect(attestation.verified).toBe(true);
    expect(attestation.requestSha256).toHaveLength(2);
  });

  it('refuses a request whose scaffold names an arm, and a vacuous identifier list', () => {
    const leak = { system: 'Candidate retrieved by MDenseOn:\n' + inputs.sources, messages: [{ role: 'user' as const, content: inputs.answer }] };
    expect(() => assertJudgeBlind(leak, inputs, ['gemma', 'mdenseon'])).toThrow(BlindingViolation);
    expect(() => assertJudgeBlind(leak, inputs, ['', 'ab'])).toThrow(/vacuous/);
  });

  it('downstream refuses a judged score without a verified attestation', () => {
    const scores = { correctness: 5, grounding: 5 };
    expect(() => acceptJudgedScore({ scores } as never)).toThrow(BlindingViolation);
    expect(() => acceptJudgedScore({ scores, blind: { verified: false } } as never)).toThrow(BlindingViolation);
    expect(acceptJudgedScore({ scores, blind: { verified: true, requestSha256: ['x'], forbiddenChecked: 2 } })).toBe(scores);
  });
});

describe('runAnswerUsefulness', () => {
  it('pairs arms on identical answer/judge contracts, coalesces identical contexts and replays exact receipts', async () => {
    const dir = tmp();
    const fx = writeFixture(dir);
    const calls: Call[] = [];
    const receipts = path.join(dir, 'receipts');
    const report = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out.json'), llm: fakeLlm(calls), baseline: 'mdenseon', concurrency: 3, bootstrapIters: 500 });

    const answers = calls.filter((c) => c.model === ANSWER_CONTRACT.model);
    const judges = calls.filter((c) => c.model === ANSWER_JUDGE_MODEL);
    // q2 has byte-identical context in both arms: one answer, one judgment per pass.
    expect(answers).toHaveLength(5);
    expect(judges).toHaveLength(10);
    // Identical answer contract for every arm.
    expect(new Set(answers.map((c) => `${c.system}|${c.temperature}|${c.maxTokens}`)).size).toBe(1);
    // No judge request names an arm outside corpus content (memory:b mentions gemma legitimately).
    for (const c of judges) expect([c.system, ...c.messages.map((m) => m.content)].join('\n').toLowerCase()).not.toContain('mdenseon');

    const row = (id: string) => report.rows.find((r) => r.id === id)!.arms;
    expect(row('q1').mdenseon).toMatchObject({ abstained: true, useful: false, contextHasGold: false });
    expect(row('q1').gemma).toMatchObject({ abstained: false, useful: true, citationGoldPrecision: 1, citedLabels: ['S1'] });
    expect(row('q2').gemma.answerFingerprint).toBe(row('q2').mdenseon.answerFingerprint);
    expect(row('q3').mdenseon).toMatchObject({ abstained: false, useful: false, unsupportedAnswer: true });
    expect(row('q3').gemma).toMatchObject({ abstained: true, useful: true, unsupportedAnswer: false });

    expect(report.summary.mdenseon.all).toMatchObject({ queries: 3, usefulRate: 1 / 3, groundedAccuracy: 0.5, correctRejection: 0, unsupportedOnUnanswerable: 1 });
    expect(report.summary.gemma.all).toMatchObject({ usefulRate: 1, groundedAccuracy: 1, correctRejection: 1, unsupportedAnswerRate: 0 });
    const paired = report.paired.gemma!;
    expect(paired.vs).toBe('mdenseon');
    expect(paired.useful).toMatchObject({ n: 3, wins: 2, losses: 0 });
    expect(paired.useful.mean).toBeCloseTo(2 / 3);
    expect(paired.unsupportedAnswer).toMatchObject({ n: 3, wins: 0, losses: 1 });
    expect(report.agreement.correctness).toMatchObject({ n: 6, binaryAgreement: 1 });
    expect(report.cost).toMatchObject({ answerCalls: 5, judgeCalls: 10, answerReplays: 0, judgeReplays: 0 });
    expect(report.cost.uniqueTotalUsd).toBeCloseTo(5 * 0.001 + 10 * 0.004);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).paired.gemma.useful.wins).toBe(2);

    // Exact-fingerprint replay: no model call, identical outcomes.
    const replayCalls: Call[] = [];
    const replay = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out-2.json'), llm: fakeLlm(replayCalls), baseline: 'mdenseon', bootstrapIters: 500 });
    expect(replayCalls).toHaveLength(0);
    expect(replay.cost).toMatchObject({ answerCalls: 0, judgeCalls: 0, answerReplays: 5, judgeReplays: 10 });
    expect(replay.summary).toEqual(report.summary);
    expect(replay.paired).toEqual(report.paired);

    // A receipt whose request no longer matches is refused, never reused or re-called.
    const answerDir = path.join(receipts, 'answers');
    const first = path.join(answerDir, fs.readdirSync(answerDir)[0]!);
    const saved = JSON.parse(fs.readFileSync(first, 'utf8'));
    saved.request.system = 'tampered';
    fs.writeFileSync(first, JSON.stringify(saved));
    await expect(runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out-3.json'), llm: fakeLlm([]), baseline: 'mdenseon' }))
      .rejects.toThrow(/does not match its request fingerprint/);
  });

  it('the blinding guard is live in the runner: an arm identifier that the judge scaffold carries stops the run', async () => {
    const dir = tmp();
    // The judge scaffold names its scenario ("answer-usefulness"); an arm whose report file has that name is identifiable.
    const fx = writeFixture(dir, { names: { gemma: ANSWER_JUDGE_INSTRUCTIONS.scenarioId } });
    const calls: Call[] = [];
    await expect(runAnswerUsefulness({ ...fx, receipts: path.join(dir, 'r'), out: path.join(dir, 'out.json'), llm: fakeLlm(calls) }))
      .rejects.toThrow(BlindingViolation);
    expect(calls.filter((c) => c.model === ANSWER_JUDGE_MODEL)).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'out.json'))).toBe(false);
  });

  it('refuses arm reports that do not share snapshot, labels and query set, and synthetic measurements', () => {
    const dir = tmp();
    const fx = writeFixture(dir, { synthetic: true });
    expect(() => loadArmReports(fx.reports, fx.snapshot, fx.gold)).toThrow(/synthetic-embedder/);
    expect(loadArmReports(fx.reports, fx.snapshot, fx.gold, true).corpus).toBe('memory');
    expect(() => loadArmReports([fx.reports[0]!], fx.snapshot, fx.gold, true)).toThrow(/at least two/);
    expect(() => loadArmReports([fx.reports[0]!, fx.reports[0]!], fx.snapshot, fx.gold, true)).toThrow(/duplicate arm/);
    fs.appendFileSync(fx.snapshot, ' ');
    expect(() => loadArmReports(fx.reports, fx.snapshot, fx.gold, true)).toThrow(/different snapshot/);
  });
});
