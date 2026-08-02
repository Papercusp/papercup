/**
 * Guard: no Vditor render path may ship document content to plantuml.com.
 *
 * cdn-egress-fixes-2026-08-02 P-002. Two independent assertions, because the
 * fix has two independent ways to regress:
 *
 *  1. the transform itself stops neutralising the class, or
 *  2. a Vditor entry point stops passing the transform.
 *
 * Either one silently restores content egress, so both are pinned.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { neutralizePlantuml, PLANTUML_NEUTRALIZED_CLASS } from './vditor-plantuml-guard';
import { stripJsComments } from './strip-js-comments';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKDOWN_EDITOR = resolve(HERE, 'MarkdownEditor.tsx');

describe('plantuml egress guard (cdn-egress-fixes-2026-08-02 P-002)', () => {
  it('neutralises the class vditor’s adapter selects on', () => {
    const html = '<pre><code class="language-plantuml">@startuml\nA -> B\n@enduml</code></pre>';

    const out = neutralizePlantuml(html);

    // `plantumlRenderAdapter.getElements` does querySelectorAll('.language-plantuml').
    // If that token survives, the <object> is created and the request goes out.
    expect(out).not.toMatch(/class="language-plantuml"/);
    expect(out).toContain(PLANTUML_NEUTRALIZED_CLASS);
    // The source itself must survive — this hides the round trip, not the content.
    expect(out).toContain('@startuml');
  });

  it('is idempotent across re-renders', () => {
    // The editor live-preview re-transforms on every keystroke; a non-idempotent
    // rewrite would corrode the class into something unrecognisable over time.
    const once = neutralizePlantuml('<code class="language-plantuml">x</code>');

    expect(neutralizePlantuml(once)).toBe(once);
  });

  it('touches no other language block', () => {
    const html =
      '<code class="language-mermaid">a</code>' +
      '<code class="language-plantumlish">b</code>' +
      '<code class="language-ts">c</code>';

    const out = neutralizePlantuml(html);

    expect(out).toBe(html);
  });

  it('every Vditor entry point passes the transform', async () => {
    const src = stripJsComments(await readFile(MARKDOWN_EDITOR, 'utf8'));

    const entryPoints = src.match(/(?:Vditor\.preview\(|new Vditor\()/g) ?? [];
    const transforms = src.match(/transform:\s*neutralizePlantuml\b/g) ?? [];

    // Three: preloadVditor's warm render, MarkdownPreview, MarkdownEditor.
    expect(entryPoints.length).toBeGreaterThanOrEqual(3);
    expect(transforms.length).toBe(entryPoints.length);
  });
});
