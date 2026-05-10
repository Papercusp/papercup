import { describe, it, expect } from 'vitest';
import { buildDesignerPrompt } from './designer-prompt';

const baseSpec = {
  layer: 'app-default' as const,
  source: '/x/default.md',
  body: '# default rules',
  frontmatter: {},
};

describe('buildDesignerPrompt', () => {
  it('includes the framing + IR version', () => {
    const out = buildDesignerPrompt({
      designSpec: baseSpec,
      feature: { id: 'f1', title: 'add panel' },
      ecosystem: 'react-tailwind',
    });
    expect(out).toContain('designer agent');
    expect(out).toContain('UI IR v0.1');
  });

  it('renders feature metadata', () => {
    const out = buildDesignerPrompt({
      designSpec: baseSpec,
      feature: {
        id: 'f1',
        title: 'add settings page',
        summary: 'expose omp config in UI',
        acceptanceCriteria: '- searchable\n- per-section grouping',
      },
      ecosystem: 'react-tailwind',
    });
    expect(out).toContain('add settings page');
    expect(out).toContain('expose omp config in UI');
    expect(out).toContain('searchable');
  });

  it('flags redesigns and tells the agent to capture current state', () => {
    const out = buildDesignerPrompt({
      designSpec: baseSpec,
      feature: { id: 'f1', title: 'redo header', isRedesign: true },
      ecosystem: 'react-tailwind',
    });
    expect(out).toContain('redesign');
    expect(out).toContain('captureCurrentSurface');
  });

  it('includes registry + token + memo summaries when provided', () => {
    const out = buildDesignerPrompt({
      designSpec: baseSpec,
      feature: { id: 'f1', title: 't' },
      ecosystem: 'react-tailwind',
      registrySummary: [{ id: 'action.primary', summary: 'Primary CTA' }],
      tokenSummary: [{ id: 'color.bg.surface', type: 'color' }],
      memos: [{ slug: 'operator-card-lifecycle-plan', title: 'Card lifecycle', status: 'addressed' }],
    });
    expect(out).toContain('action.primary');
    expect(out).toContain('Primary CTA');
    expect(out).toContain('color.bg.surface');
    expect(out).toContain('operator-card-lifecycle-plan');
    expect(out).toContain('addressed');
  });

  it('renders the resolved DESIGN_SPEC inline', () => {
    const out = buildDesignerPrompt({
      designSpec: { ...baseSpec, body: '# special harness rules' },
      feature: { id: 'f1', title: 't' },
      ecosystem: 'react-tailwind',
    });
    expect(out).toContain('# special harness rules');
  });

  it('includes the empty-spec warning when designSpec.layer === empty', () => {
    const out = buildDesignerPrompt({
      designSpec: {
        layer: 'empty',
        source: null,
        body: '',
        frontmatter: {},
        warning: 'no DESIGN_SPEC.md found anywhere',
      },
      feature: { id: 'f1', title: 't' },
      ecosystem: 'react-tailwind',
    });
    expect(out).toContain('empty');
    expect(out).toContain('no DESIGN_SPEC.md found anywhere');
  });
});
