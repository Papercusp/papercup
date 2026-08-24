import { describe, expect, it } from 'vitest';
import { renderDependencyBottleneckMermaid } from './dependency-mermaid';

describe('renderDependencyBottleneckMermaid', () => {
  it('renders stable ids, escaped labels, and storage-direction edge semantics', () => {
    const block = renderDependencyBottleneckMermaid({
      nodes: [
        { key: 'work_item:WI-41117', kind: 'work_item', ref: 'WI-41117', status: 'open', title: 'Timeout <root>' },
        { key: 'plan_item:fleet-plan#P-046', kind: 'plan_item', ref: 'P-046', status: 'todo', title: 'Cloud "lane"' },
        { key: 'work_item:WI-40086', kind: 'work_item', ref: 'WI-40086', status: 'open', title: 'Gate owner' },
      ],
      edges: [
        {
          key: 'work',
          subjectKey: 'work_item:WI-40086',
          dependencyKey: 'work_item:WI-41117',
          relation: 'work-item-blocks',
          externalRef: null,
        },
        {
          key: 'coverage',
          subjectKey: 'plan_item:fleet-plan#P-046',
          dependencyKey: 'work_item:WI-40086',
          relation: 'coverage',
          externalRef: null,
        },
      ],
    });

    expect(block).toBe(
      [
        '```mermaid',
        'flowchart LR',
        '  n0["P-046 · todo · Cloud &quot;lane&quot;"]',
        '  n1["WI-40086 · open · Gate owner"]',
        '  n2["WI-41117 · open · Timeout &lt;root&gt;"]',
        '  n0 -.->|coverage| n1',
        '  n1 -->|blocked by| n2',
        '```',
      ].join('\n'),
    );
  });

  it('renders an explicit empty measured graph rather than omitting the block', () => {
    expect(renderDependencyBottleneckMermaid({ nodes: [], edges: [] })).toContain('No open dependency paths');
  });
});
