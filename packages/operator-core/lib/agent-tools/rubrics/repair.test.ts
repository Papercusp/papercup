/** Pure snapshot classification/formatting guards for rubrics:repair. */
import { describe, expect, it } from 'vitest';
import {
  formatRubricRevisionSnapshot,
  inspectRubricRevisionSnapshot,
  isMarkdownOnlyRubricRevisionSnapshot,
  parseRubricRevisionTemplateData,
} from '../../rubrics';

const body = '---\ntitle: Example\ntemplate: rubric\n---\n\n# Example\n';
const templateData = {
  characteristic: 'example',
  criteria: [
    {
      key: 'observable',
      title: 'Observable',
      model: 'The behavior is measurable.',
      method: 'Run the check.',
      driftMarkers: 'The check is absent.',
    },
  ],
  ratingScale: ['healthy', 'unknown'],
};

describe('rubric revision snapshot repair classification', () => {
  it('recognizes markdown-only history and appends a schema-versioned snapshot', () => {
    expect(inspectRubricRevisionSnapshot(body)).toEqual({ kind: 'markdown-only' });
    expect(isMarkdownOnlyRubricRevisionSnapshot(body)).toBe(true);

    const repaired = formatRubricRevisionSnapshot(body, templateData, 'criteria-hash');
    expect(repaired.startsWith(body)).toBe(true);
    expect(inspectRubricRevisionSnapshot(repaired)).toMatchObject({
      kind: 'enriched',
      schemaVersion: 2,
      templateData,
      criteriaHash: 'criteria-hash',
    });
    expect(parseRubricRevisionTemplateData(repaired)).toEqual(templateData);
    expect(isMarkdownOnlyRubricRevisionSnapshot(repaired)).toBe(false);
  });

  it('does not classify raw structured legacy or malformed sections as repairable markdown', () => {
    const raw = `${body}\n## Structured rubric data (\`template_data\`)\n\n~~~json\n${JSON.stringify(templateData)}\n~~~\n`;
    expect(inspectRubricRevisionSnapshot(raw)).toMatchObject({ kind: 'legacy-structured', templateData });
    expect(isMarkdownOnlyRubricRevisionSnapshot(raw)).toBe(false);

    const malformed = `${body}\n## Structured rubric data (\`template_data\`)\n\n~~~json\n{not-json}\n~~~\n`;
    expect(inspectRubricRevisionSnapshot(malformed)).toEqual({ kind: 'malformed' });
    expect(isMarkdownOnlyRubricRevisionSnapshot(malformed)).toBe(false);
    expect(parseRubricRevisionTemplateData(malformed)).toBeNull();

    const bareJson = JSON.stringify(templateData);
    expect(inspectRubricRevisionSnapshot(bareJson)).toMatchObject({ kind: 'legacy-structured', templateData });
    expect(isMarkdownOnlyRubricRevisionSnapshot(bareJson)).toBe(false);
  });
});
