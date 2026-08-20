import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const REGISTRATION_MODULES = [
  'tool',
  'text',
  'card',
  'control-tag',
  'auto-fire',
  'continue-chain',
  'latency',
] as const;

const EVALUATOR_KIND_MARKERS = [
  'tool_called',
  'text_contains',
  'card_emitted',
  'control_tag_present',
  'auto_fire_happened',
  'continue_chain_within_cap',
  'latency_under',
] as const;

describe('@papercusp/testing-shell assertion registration bundle contract', () => {
  it('keeps every top-level registration module when a consumer imports evaluateAsserts', async () => {
    const result = await build({
      stdin: {
        contents:
          "import { evaluateAsserts } from './libs/testing-shell/src/llm/asserts/index.ts'; export { evaluateAsserts };",
        resolveDir: ROOT,
        sourcefile: 'testing-shell-assert-bundle-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      metafile: true,
      logLevel: 'silent',
    });

    expect(result.warnings).toEqual([]);

    const outputMeta = Object.values(result.metafile.outputs)[0];
    expect(outputMeta).toBeDefined();

    for (const moduleName of REGISTRATION_MODULES) {
      const suffix = `/libs/testing-shell/src/llm/asserts/${moduleName}.ts`;
      const contribution = Object.entries(outputMeta.inputs).find(([path]) => `/${path}`.endsWith(suffix));
      expect(contribution?.[1].bytesInOutput, `${moduleName}.ts must contribute executable registration code`).toBeGreaterThan(0);
    }

    const output = result.outputFiles[0]?.text ?? '';
    for (const kind of EVALUATOR_KIND_MARKERS) {
      expect(output, `bundle must retain the '${kind}' evaluator registration`).toContain(kind);
    }
  });
});
