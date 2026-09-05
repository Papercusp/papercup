import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  judgeBridgeEvalContract,
  judgeBridgeEvalProse,
  type DocSubject,
} from './bridge-eval-timeout-prose';

/** Repo root from this file: packages/operator-core/lib/doc-claims → up four. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const DEV_BRIDGE = 'papercusp-desktop/src-tauri/src/dev_bridge.rs';

/** The prose that actually reaches an agent driving the operator headlessly. */
const SUBJECT_PATHS = ['apps/operator-docs/src/content/docs/testing/agent-e2e.mdx'];

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function readSubject(rel: string): DocSubject {
  return { label: rel, text: read(rel) };
}

/**
 * A minimal stand-in for the real handler, carrying only the three lines the claim
 * rests on. Each control below mutates exactly one of them.
 */
const FIXTURE_RUST = [
  'let deadline = std::time::Duration::from_secs(5);',
  'let _ = request.respond(Response::from_string("Eval timeout").with_status_code(504));',
  'value: "ERROR: " + e.message',
].join('\n');

describe('bridge /eval contract doc claim (EI-15751)', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('reads the deadline, status code and error-as-value contract out of the source', () => {
      const c = judgeBridgeEvalContract(FIXTURE_RUST);
      expect(c.problems).toEqual([]);
      expect(c.ok).toBe(true);
      expect(c.deadlineSecs).toBe(5);
      expect(c.timeoutStatusCodes).toEqual([504]);
      expect(c.reportsExceptionsAsValue).toBe(true);
    });

    it('catches a deadline that moved — the whole point of §1.7 is the NUMBER', () => {
      const c = judgeBridgeEvalContract(
        FIXTURE_RUST.replace('from_secs(5)', 'from_secs(30)'),
      );
      expect(c.deadlineSecs).toBe(30);
      // The contract itself is still coherent at 30s; it is the PROSE that goes stale,
      // which is what the prose judge below is for.
      const v = judgeBridgeEvalProse([{ label: 'doc', text: 'dies at 5 s, Duration::from_secs(5), 504, ERROR: x' }], c);
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('30 s');
    });

    it('catches the deadline anchor being renamed away, rather than passing silently', () => {
      const c = judgeBridgeEvalContract(FIXTURE_RUST.replace('let deadline', 'let cutoff'));
      expect(c.ok).toBe(false);
      expect(c.deadlineSecs).toBeNull();
      expect(c.problems.join(' ')).toContain('deadline moved');
    });

    it('catches a timeout answered with a status other than 504', () => {
      const c = judgeBridgeEvalContract(FIXTURE_RUST.replace('with_status_code(504)', 'with_status_code(408)'));
      expect(c.ok).toBe(false);
      expect(c.problems.join(' ')).toContain('504');
    });

    it('catches /eval growing a real error channel — good news that still invalidates the prose', () => {
      const c = judgeBridgeEvalContract(
        FIXTURE_RUST.replace('value: "ERROR: " + e.message', 'error: e.message, value: null'),
      );
      expect(c.ok).toBe(false);
      expect(c.reportsExceptionsAsValue).toBe(false);
      expect(c.problems.join(' ')).toContain('error channel');
    });

    it('catches prose that states the deadline but never cites the code it came from', () => {
      const c = judgeBridgeEvalContract(FIXTURE_RUST);
      const v = judgeBridgeEvalProse([{ label: 'doc', text: 'it dies at 5 s. 504. ERROR: x' }], c);
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('Duration::from_secs(5)');
    });

    it('catches prose that drops the "ERROR: " result-as-value contract', () => {
      const c = judgeBridgeEvalContract(FIXTURE_RUST);
      const v = judgeBridgeEvalProse(
        [{ label: 'doc', text: 'dies at 5 s via Duration::from_secs(5), answering 504.' }],
        c,
      );
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('result-as-value');
    });

    it('reports an empty subject as proving nothing, never as agreement', () => {
      // An unreadable or emptied doc must not read as "the prose is fine": silence and
      // agreement are the two readings this guard exists to keep apart.
      const c = judgeBridgeEvalContract(FIXTURE_RUST);
      const v = judgeBridgeEvalProse([{ label: 'doc', text: '   ' }], c);
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('proved nothing');
    });
  });

  describe('the live tree', () => {
    it('keeps the /eval contract §1.7 describes', () => {
      const source = read(DEV_BRIDGE);
      // Positive control on the INSTRUMENT, not the subject: an unreadable or truncated
      // file would also yield "anchors missing", so assert it saw a real handler first.
      expect(source).toContain('build_eval_callback_js');

      const c = judgeBridgeEvalContract(source);
      expect(c.problems).toEqual([]);
      expect(c.ok).toBe(true);
      expect(c.deadlineSecs).toBe(5);
      expect(c.timeoutStatusCodes.length).toBeGreaterThan(0);
      expect(c.reportsExceptionsAsValue).toBe(true);
    });

    it('keeps testing/agent-e2e agreeing with it', () => {
      const c = judgeBridgeEvalContract(read(DEV_BRIDGE));
      const v = judgeBridgeEvalProse(SUBJECT_PATHS.map(readSubject), c);
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
    });
  });
});
