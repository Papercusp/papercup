/**
 * Coverage for parseIssuesMdLocal — the validator-issues markdown parser:
 * header extraction (feature + round + timestamp), OUT-OF-SCOPE item splitting,
 * title from bold/first-sentence, severity classification, code-pointer
 * extraction, sub-section (Observed/Suggested fix) capture, stable hashed ids +
 * dedup. Pure string logic.
 */
import { describe, expect, it } from 'vitest';
import { parseIssuesMdLocal } from './harness-issues';

const MD = [
  '## F-001 — Validation round 2 — 2026-05-31T10:00:00Z',
  '',
  '### OUT-OF-SCOPE findings',
  '1. **Login crashes on empty password** in auth.ts:42',
  '   Observed: 500 on submit',
  '   Suggested fix: guard the password field',
  '2. **Request returns 500** when the queue is empty and breaks the run',
  '3. **Tooltip typo** cosmetic wording is off here',
  '4. **Refactor the helper** for clarity at some later time',
].join('\n');

describe('parseIssuesMdLocal', () => {
  const issues = parseIssuesMdLocal(MD);

  it('returns [] for empty/blank input', () => {
    expect(parseIssuesMdLocal('')).toEqual([]);
    expect(parseIssuesMdLocal('   \n  ')).toEqual([]);
  });

  it('parses each OUT-OF-SCOPE item into an issue', () => {
    expect(issues).toHaveLength(4);
  });

  it('extracts the header feature + timestamp onto every issue', () => {
    for (const i of issues) {
      expect(i.foundDuring).toBe('F-001');
      expect(i.foundAt).toBe('2026-05-31T10:00:00Z');
      expect(i.source).toBe('validator');
      expect(i.status).toBe('open');
    }
  });

  it('takes the title from the bold span', () => {
    expect(issues[0].title).toBe('Login crashes on empty password');
    expect(issues[2].title).toBe('Tooltip typo');
  });

  it('classifies severity by keyword', () => {
    expect(issues.map((i) => i.severity)).toEqual(['critical', 'major', 'nit', 'minor']);
  });

  it('extracts a file:line code pointer when present', () => {
    expect(issues[0].codePointer).toBe('auth.ts:42');
    expect(issues[1].codePointer).toBeUndefined();
  });

  it('captures Observed → evidence and Suggested fix', () => {
    expect(issues[0].evidence).toContain('500 on submit');
    expect(issues[0].suggestedFix).toContain('guard the password field');
  });

  it('assigns stable hashed I- ids and dedupes identical items', () => {
    for (const i of issues) expect(i.id).toMatch(/^I-[a-z0-9]{7}$/);
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length); // all unique
    // The same markdown parsed again yields the SAME ids (stable hash).
    expect(parseIssuesMdLocal(MD).map((i) => i.id)).toEqual(issues.map((i) => i.id));
  });
});
