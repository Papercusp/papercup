import { describe, it, expect } from 'vitest';
import { createReactTailwindAdapter } from './index';
import { _internal as tokensInternal } from './tokens';
import { _internal as codeInternal } from './code-emit';
import { assertAdapterConformant } from '../design-adapter';
import type { UiIr } from '../design-ir';
import { IR_VERSION } from '../design-ir';

const adapter = createReactTailwindAdapter();

describe('react-tailwind adapter — conformance', () => {
  it('passes the conformance check', async () => {
    await expect(assertAdapterConformant(adapter)).resolves.toBeUndefined();
  });

  it('declares the expected capabilities', () => {
    expect(adapter.capabilities.sort()).toEqual(['codeEmit', 'registry', 'tokens']);
  });

  it('claims react-tailwind ecosystem with 0.x IR support', () => {
    expect(adapter.ecosystem).toBe('react-tailwind');
    expect(adapter.irVersionsSupported).toContain('0.x');
  });

  it('defaults registry scans to live operator harness paths', () => {
    expect(adapter.registry?.sourcePaths).toEqual(['apps/operator/app/harness/']);
  });
});

describe('registry surface', () => {
  it('lists curated primitives, all with react-tailwind source pointers', async () => {
    const list = await adapter.registry!.listPrimitives();
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(e.ecosystems['react-tailwind']?.sourcePointer).toBeDefined();
    }
  });

  it('resolves sourceFor known id', async () => {
    const ptr = await adapter.registry!.sourceFor('action.primary');
    expect(ptr).not.toBeNull();
    expect(ptr!.path).toContain('Button.tsx');
  });

  it('returns null for unknown id', async () => {
    const ptr = await adapter.registry!.sourceFor('unknown.thing');
    expect(ptr).toBeNull();
  });
});

describe('tokens surface', () => {
  it('emits CSS vars and Tailwind preset on a minimal DTCG doc', async () => {
    const out = await adapter.tokens!.emit({
      tokens: [
        { id: 'color.bg.surface', type: 'color', value: '#ffffff' },
        { id: 'space.md', type: 'dimension', value: '12px' },
      ],
    });
    expect(out.length).toBe(2);
    const css = out.find((f) => f.path.endsWith('.css'))!;
    const tw = out.find((f) => f.path.endsWith('.ts'))!;
    expect(css.contents).toContain('--color-bg-surface: #ffffff;');
    expect(css.contents).toContain('--space-md: 12px;');
    expect(tw.contents).toContain('"colors"');
    expect(tw.contents).toContain('"spacing"');
    expect(tw.contents).toContain('var(--color-bg-surface)');
  });

  it('tokenIdToCssVar maps dot.notation to dash-notation', () => {
    expect(tokensInternal.tokenIdToCssVar('color.bg.surface')).toBe('--color-bg-surface');
  });
});

describe('codeEmit surface', () => {
  function emit(ir: UiIr) {
    return adapter.codeEmit!.fromIR(ir, { outDir: 'out', mode: 'preview' });
  }

  it('emits a TSX file named after the surface', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'demo',
      ecosystem: 'react-tailwind',
      layout: { kind: 'stack', direction: 'vertical' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('out/demo.generated.tsx');
  });

  it('renders a stack as flex flex-col', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: { kind: 'stack', direction: 'vertical', gap: { token: 'space.md' } },
    });
    expect(out[0].contents).toContain('flex flex-col gap-[var(--space-md)]');
  });

  it('renders header + heading + text + button', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'stack',
        direction: 'vertical',
        children: [
          { kind: 'header', title: { default: 'Hello', key: 'h.k' } },
          { kind: 'heading', copy: { default: 'Sub', key: 's.k' } },
          { kind: 'text', copy: { default: 'body', key: 'b.k' } },
          { kind: 'button', label: { default: 'Go', key: 'g.k' }, a11y: { ariaLabel: { default: 'Go now', key: 'g.a' } } },
        ],
      },
    });
    const code = out[0].contents;
    expect(code).toContain('<h2>Hello</h2>');
    expect(code).toContain('<h2>Sub</h2>');
    expect(code).toContain('<span>body</span>');
    expect(code).toContain('aria-label="Go now"');
    expect(code).toContain('Go now</button>');
  });

  it('renders a list with empty-state', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'list',
        emptyState: {
          kind: 'empty-state',
          copy: { default: 'No items.', key: 'e.k' },
          icon: 'inbox',
        },
        item: { kind: 'text', copy: { default: 'item', key: 'i.k' } },
      },
    });
    const code = out[0].contents;
    expect(code).toContain('items.length === 0');
    expect(code).toContain('<Icon name="inbox" />');
    expect(code).toContain("import * as LucideIcons from 'lucide-react';");
    expect(code).toContain('function Icon({ name }');
    expect(code).toContain('items.map');
  });

  it('renders a card with title/body/actions slots', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'card',
        slots: {
          title: { kind: 'heading', copy: { default: 'C', key: 'c.k' } },
          body: { kind: 'text', copy: { default: 'B', key: 'b.k' } },
          actions: { kind: 'button', a11y: { ariaLabel: { default: 'Do', key: 'd.k' } } },
        },
      },
    });
    const code = out[0].contents;
    expect(code).toContain('<article');
    expect(code).toContain('<h2>C</h2>');
    expect(code).toContain('<span>B</span>');
    expect(code).toContain('<button');
  });

  it('renders kind="component" via registry binding', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: { kind: 'component', ref: 'btn' },
      components: [{ id: 'btn', registry: 'action.primary', props: { label: 'Accept' } }],
    });
    const code = out[0].contents;
    expect(code).toContain('<ActionPrimary label="Accept" />');
    expect(code).toContain('TODO: import ActionPrimary via the react-tailwind registry importHints');
    expect(code).not.toContain('@papercusp/ui');
  });

  it('renders kind="chart" with an inlined Plotly spec', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'chart',
        spec: { data: [{ x: [1], y: [1], type: 'scatter' }] },
      },
    });
    const code = out[0].contents;
    expect(code).toContain('<PlotlyChart spec=');
    expect(code).toContain("import { PlotlyChart } from '@papercusp/charts';");
  });

  it('renders kind="raw" payload when ecosystem matches', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: { kind: 'raw', ecosystem: 'react-tailwind', payload: '<MyCustom/>' },
    });
    expect(out[0].contents).toContain('<MyCustom/>');
  });

  it('emits a TODO for unknown kinds (does not silently drop)', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: { kind: 'totally-unknown' as never },
    });
    expect(out[0].contents).toContain('TODO emit kind="totally-unknown"');
  });

  it('deriveComponentName converts kebab to PascalSurface suffix', () => {
    expect(codeInternal.deriveComponentName('operator-panel')).toBe('OperatorPanelSurface');
  });

  it('does not emit retired package or source references', async () => {
    const out = await emit({
      irVersion: IR_VERSION,
      surface: 'd',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'stack',
        direction: 'vertical',
        children: [
          { kind: 'component', ref: 'btn' },
          { kind: 'icon', icon: 'inbox' },
        ],
      },
      components: [{ id: 'btn', registry: 'action.primary', props: { label: 'Accept' } }],
    });
    expect(out[0].contents).not.toContain('@papercusp/ui');
    expect(out[0].contents).not.toContain('_retired');
  });
});
