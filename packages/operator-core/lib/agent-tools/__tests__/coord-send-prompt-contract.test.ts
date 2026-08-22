/**
 * EI-20228696291749016 — Papercup's delegation playbooks must teach the
 * live coord:send/loop:end call shapes, not the retired string-body examples.
 *
 * This is a source-text guard because these role playbooks are the canonical
 * prompt inputs. It deliberately checks the inline call examples rather than
 * importing the prompt renderer, keeping the regression test side-effect free.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const SOURCES = [
  'apps/operator/prompts/papercup.tools.md',
  'apps/operator/prompts/papercup-deep.tools.md',
].map((relative) => ({ relative, text: readFileSync(resolve(REPO, relative), 'utf8') }));

describe('Papercup coordination prompt contract (EI-20228696291749016)', () => {
  for (const { relative, text } of SOURCES) {
    describe(relative, () => {
      it('teaches the required envelope and structured body in every inline send example', () => {
        const examples = [...text.matchAll(/`coord:send\s*\{([\s\S]*?)\}`/g)].map((match) => match[1]);
        expect(examples.length, 'the delegation protocol must retain inline coord:send examples').toBeGreaterThan(0);

        for (const example of examples) {
          expect(example).toMatch(/summary:/);
          expect(example).toMatch(/expects:\s*'(?:ack|answer|action|none)'/);

          if (/body:/.test(example)) {
            expect(example).toMatch(/body:\s*\[\s*\{\s*text:/);
          }
          if (/expects:\s*'(?:answer|action)'/.test(example)) {
            expect(example).toMatch(/forYouBecause:\s*\{/);
          }
        }
      });

      it('keeps the owner-scoped loop:end rule beside the coordination guidance', () => {
        expect(text).toMatch(/`loop:end` is owner-scoped and intentionally has no `harness` argument/i);
      });
    });
  }
});
