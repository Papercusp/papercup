import { describe, it, expect } from 'vitest';
import { findShellSyntaxError } from './shell-syntax';

describe('findShellSyntaxError — the pure bash -n wrapper (EI-13192)', () => {
  it('returns null for a syntactically valid script', () => {
    expect(findShellSyntaxError('#!/bin/bash\necho hi\nif true; then\n  echo ok\nfi\n')).toBeNull();
  });

  it('flags an unterminated if/fi with the line + reason bash reports', () => {
    const err = findShellSyntaxError('echo hi\nif true; then\n  echo ok\n');
    expect(err).not.toBeNull();
    expect(err?.line).toBeGreaterThan(0);
    expect(err?.reason).toMatch(/unexpected end of file/i);
  });

  it('flags a stray closing brace (the EI-13192 shape — a relocated `fi`/brace glued onto an unrelated line)', () => {
    const err = findShellSyntaxError('foo() {\n  echo hi\n}  # end\nfi\n');
    expect(err).not.toBeNull();
    expect(err?.reason).toMatch(/unexpected/i);
  });

  it('is a real parser, not a heuristic — a script with `fi`/`done` as plain strings is clean', () => {
    expect(findShellSyntaxError('echo "fi done esac"\n')).toBeNull();
  });
});
