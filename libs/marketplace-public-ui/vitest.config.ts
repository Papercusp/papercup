import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';

// P-006: marketplace-public-ui had no test infra. The shared config provides the
// standard unit-layer setup; the esbuild merge forces the automatic JSX runtime
// so component tests need no explicit React import (these components, like the
// operator's, omit it and rely on the build's automatic runtime).
export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});
