import { describe, expect, it } from 'vitest';
import { astGrepSyntaxIndex, buildSyntaxIndexArgs, SYNTAX_INDEX_KINDS } from './ast-grep-facade';

describe('P-005 syntax profile admission', () => {
  it('uses the maintained grammars in read-only stdin mode', () => {
    for (const language of Object.keys(SYNTAX_INDEX_KINDS) as Array<keyof typeof SYNTAX_INDEX_KINDS>) {
      const args = buildSyntaxIndexArgs(language);
      expect(args).toContain('--stdin');
      expect(args).toContain('--json=compact');
      expect(args).not.toContain('--update-all');
      expect(args).not.toContain('-U');
      expect(args.join(' ')).toContain('declaration');
      expect(args.join(' ')).toContain('imports');
    }
  });
  it('rejects an unadmitted grammar instead of certifying an empty result', async () => {
    const result = await astGrepSyntaxIndex({ language: 'cpp' as 'ts', rootPath: '/absent', paths: ['x.cpp'] });
    expect(result.error).toContain('unsupported');
    expect(result.freshness.health).toBe('unknown');
    expect(result.sites).toEqual([]);
    expect(() => buildSyntaxIndexArgs('cpp' as 'ts')).toThrow(/unsupported/);
  });
});
