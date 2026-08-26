import { beforeAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS lint guard, imported for its scanner predicates.
import { findGuards, scanTree } from '../../../scripts/check-no-hand-rolled-cli-entry.mjs';

describe('lint:no-hand-rolled-cli-entry — predicate controls', () => {
  it('finds the pathToFileURL spelling, including nested argv aliases', () => {
    const source = `
      const argv1 = process.argv[1];
      if (import.meta.url === pathToFileURL(realpathSync(argv1)).href) main();
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual(['path-to-file-url']);
  });

  it('finds the template-literal and fileURLToPath spellings', () => {
    const source = `
      const a = import.meta.url === \`file://\${process.argv[1]}\`;
      const b = fileURLToPath(import.meta.url) === process.argv[1];
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual([
      'file-template',
      'file-url-to-path',
    ]);
  });

  it('finds fileURLToPath comparisons hidden behind resolve wrappers', () => {
    const source = `
      const invokedDirectly = process.argv[1] &&
        resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
    `;
    expect(findGuards(source).map((hit: { kind: string }) => hit.kind)).toEqual(['file-url-to-path']);
  });

  it('ignores comments, strings, and regex bodies that quote the banned idiom', () => {
    const source = `
      // import.meta.url === pathToFileURL(process.argv[1]).href
      const prose = 'import.meta.url === pathToFileURL(process.argv[1]).href';
      const quoted = /import\\.meta\\.url === pathToFileURL\\(process\\.argv\\[1\\]\\)/;
    `;
    expect(findGuards(source)).toEqual([]);
  });

  it('does not flag the sanctioned helper call', () => {
    expect(findGuards("if (isCliEntry(import.meta.url)) main();")).toEqual([]);
  });
});

describe('lint:no-hand-rolled-cli-entry — repository ratchet', () => {
  let repositoryScan: ReturnType<typeof scanTree>;

  beforeAll(() => {
    repositoryScan = scanTree();
  }, 60_000);

  it('has no unallowlisted guard and no stale baseline entry', () => {
    const result = repositoryScan;
    expect(result.violations.map((hit: { rel: string; line: number; kind: string }) => `${hit.rel}:${hit.line}:${hit.kind}`)).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.staleExemptions).toEqual([]);
  });

  it('has no standalone exception for the dependency-free systemd runner', () => {
    const result = repositoryScan;
    expect(result.exemptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel: 'packages/operator-core/lib/systemd-scope-env-runner.mjs' }),
      ]),
    );
  });
});
