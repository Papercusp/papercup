import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STUDY_BLOCKS, requireStudyRoom, validateStudyBlocks, type StudyTotal } from '../../../../scratchpad/dream-study-2026-09-09/accounting.mts';

const blocks = Object.values(STUDY_BLOCKS).map(block => JSON.parse(readFileSync(new URL('../../../../scratchpad/dream-study-2026-09-09/' + block.file, import.meta.url), 'utf8')));
const limits = validateStudyBlocks(blocks);
const row = (pin: string, attempts: number, cost: number, arm: StudyTotal['arm'] = 'structured-pair'): StudyTotal => ({ pin, attempts, cost, arm });

describe('finite Dream study accounting across model blocks', () => {
  it('retains the original failures and unknown reservation after a model switch', () => {
    const result = requireStudyRoom([
      row(STUDY_BLOCKS.haiku.pin, 2, 0.0551394),
      row(STUDY_BLOCKS.haiku.pin, 1, 0, 'structured-triple'),
      row(STUDY_BLOCKS.haiku.pin, 1, 0.0149784, 'uniform-pair'),
      row(STUDY_BLOCKS.luna.pin, 1, 0.1),
    ], 'structured-pair', limits);
    expect(result.attempts).toBe(5);
    expect(result.armAttempts).toBe(3);
    expect(result.accountedUsd).toBeCloseTo(0.1701178);
  });
  it('does not reset an arm attempt or money ceiling with a fresh model pin', () => {
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 2, 0.05), row(STUDY_BLOCKS.luna.pin, 48, 1)], 'structured-pair', limits)).toThrow(/cap reached/);
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 2, 30), row(STUDY_BLOCKS.luna.pin, 1, 11)], 'structured-pair', limits)).toThrow(/cap reached/);
  });
  it('counts all arms toward the total and reserves a complete next cycle', () => {
    const rows = ['blender', 'uniform-pair', 'structured-pair', 'structured-triple'].map(arm => row(STUDY_BLOCKS.haiku.pin, 50, 45, arm as StudyTotal['arm']));
    expect(() => requireStudyRoom(rows, 'structured-pair', limits)).toThrow(/cap reached/);
    const expensive = rows.map(r => ({ ...r, attempts: 1, cost: r.arm === 'structured-pair' ? 1 : 64 }));
    expect(() => requireStudyRoom(expensive, 'structured-pair', limits)).toThrow(/cap reached/);
  });
  it('fails closed for missing historical blocks, changed pins, and invalid accounting', () => {
    expect(() => validateStudyBlocks(blocks.slice(1))).toThrow(/every historical block/);
    const changed = structuredClone(blocks); changed[1].protocol.limits.attempts = 201;
    expect(() => validateStudyBlocks(changed)).toThrow();
    for (const bad of [null, NaN, -1]) expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 1, bad as number)], 'structured-pair', limits)).toThrow(/Invalid/);
  });
});
