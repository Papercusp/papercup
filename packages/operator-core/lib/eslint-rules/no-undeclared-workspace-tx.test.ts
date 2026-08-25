/** Runtime-enrolled RuleTester coverage for the workspace-tx opt-in lint. */
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);
const { RuleTester } = require('eslint');
const rule = require('../../../../tools/eslint-rules/no-undeclared-workspace-tx.js');

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('papercusp/no-undeclared-workspace-tx', () => {
  it('requires the opt-in for direct and file-local aliased tx reads', () => {
    tester.run('no-undeclared-workspace-tx', rule, {
      valid: [
        {
          code: `defineTool({ name: 'demo:plain', handler: async (_args, ctx) => ctx.workspaceId });`,
        },
        {
          code: `defineTool({ name: 'demo:tx', needsWorkspaceTx: true, handler: async (_args, ctx) => ctx.tx\`SELECT 1\` });`,
        },
        {
          code: `
            const helper = (ctx) => ctx.tx;
            defineTool({ name: 'demo:helper', needsWorkspaceTx: true, handler: async (_args, ctx) => helper(ctx) });
          `,
        },
        {
          // A helper module with no projected definition is outside the rule's contract.
          code: `export const helper = (ctx) => ctx.tx;`,
        },
      ],
      invalid: [
        {
          code: `defineTool({ name: 'demo:missing', handler: async (_args, ctx) => ctx.tx\`SELECT 1\` });`,
          errors: [{ messageId: 'undeclared', data: { tool: 'demo:missing' } }],
        },
        {
          code: `
            defineTool({ name: 'demo:aliased', handler: async (_args, ctx) => {
              const scoped = harnessScopedCtx('x', ctx);
              return scoped.tx;
            }});
          `,
          errors: [{ messageId: 'undeclared', data: { tool: 'demo:aliased' } }],
        },
        {
          code: `defineTool({ name: 'demo:false', needsWorkspaceTx: false, handler: async (_args, ctx) => ctx['tx'] });`,
          errors: [{ messageId: 'undeclared', data: { tool: 'demo:false' } }],
        },
      ],
    });
  });
});
