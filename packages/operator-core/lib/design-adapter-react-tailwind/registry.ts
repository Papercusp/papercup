/**
 * React + Tailwind registry surface.
 *
 * v0.1 ships a hand-curated set of primitives mapping the most-used
 * `libs/papercusp/` components. The full TS-prop-extractor (using
 * ts-morph or the TS compiler API) is intentionally deferred — getting
 * to a working end-to-end loop matters more than auto-extraction
 * accuracy for the v0.1 milestone.
 *
 * Future: replace `HANDCURATED` with a scanner that walks
 * `sourcePaths`, parses TSX, infers props from interfaces / FC<P>
 * signatures, and captures Storybook screenshots as examples.
 */
import type { RegistryEntry, RegistrySurface, SourcePointer } from '../design-adapter';

const ECOSYSTEM = 'react-tailwind';

const HANDCURATED: RegistryEntry[] = [
  {
    id: 'action.primary',
    kind: 'component',
    summary: 'Primary call-to-action button',
    inputs: [
      { name: 'label', type: 'string', required: true },
      { name: 'icon', type: 'icon' },
      { name: 'disabled', type: 'boolean' },
      { name: 'loading', type: 'boolean' },
    ],
    variants: ['default', 'loading', 'disabled'],
    states: ['hover', 'focus', 'active'],
    ecosystems: {
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/papercusp/_retired/apps-web/app/harness/Button.tsx' },
        importHint: "import { Button } from '@papercusp/ui'",
        propMap: { label: 'children', icon: 'leftIcon' },
      },
    },
  },
  {
    id: 'action.secondary',
    kind: 'component',
    summary: 'Secondary / ghost button',
    inputs: [
      { name: 'label', type: 'string', required: true },
      { name: 'icon', type: 'icon' },
    ],
    variants: ['ghost', 'outline'],
    ecosystems: {
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/papercusp/_retired/apps-web/app/harness/Button.tsx' },
        importHint: "import { Button } from '@papercusp/ui'",
        propMap: { label: 'children' },
      },
    },
  },
  {
    id: 'control.select',
    kind: 'component',
    summary: 'Dropdown select control',
    inputs: [
      { name: 'value', type: 'string', required: true },
      { name: 'options', type: 'array<{value,label}>', required: true },
      { name: 'placeholder', type: 'string' },
    ],
    ecosystems: {
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/papercusp/_retired/apps-web/app/harness/Select.tsx' },
        importHint: "import { Select } from '@papercusp/ui'",
      },
    },
  },
  {
    id: 'control.checkbox',
    kind: 'component',
    summary: 'Checkbox',
    inputs: [
      { name: 'checked', type: 'boolean', required: true },
      { name: 'label', type: 'string' },
    ],
    ecosystems: {
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/papercusp/_retired/apps-web/app/harness/Checkbox.tsx' },
        importHint: "import { Checkbox } from '@papercusp/ui'",
      },
    },
  },
  {
    id: 'feedback.banner',
    kind: 'component',
    summary: 'Inline banner for status/error/success messages',
    inputs: [
      { name: 'tone', type: '"info"|"warning"|"error"|"success"' },
      { name: 'children', type: 'ReactNode', required: true },
    ],
    ecosystems: {
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/papercusp/_retired/apps-web/app/harness/Banner.tsx' },
        importHint: "import { Banner } from '@papercusp/ui'",
      },
    },
  },
];

export function makeReactTailwindRegistry(opts: { sourcePaths: string[] }): RegistrySurface {
  return {
    sourcePaths: opts.sourcePaths,
    async listPrimitives() {
      return HANDCURATED;
    },
    async sourceFor(id: string): Promise<SourcePointer | null> {
      const e = HANDCURATED.find((r) => r.id === id);
      return e?.ecosystems[ECOSYSTEM]?.sourcePointer ?? null;
    },
  };
}

/** Test-only export of the curated set for round-trip + integration tests. */
export const _CURATED_FOR_TESTS = HANDCURATED;
