import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { resolve } from 'node:path';

const operatorRoot = resolve(import.meta.dirname, '../operator');

export default mergeConfig(defineVitestConfig({ layer: 'unit' }), {
  resolve: {
    alias: [
      { find: '@', replacement: operatorRoot },
      // Shim next/* the same way vite.config.ts does so operator components
      // can be imported in tests without a real Next.js runtime.
      { find: /^next\/navigation$/, replacement: resolve(import.meta.dirname, 'shims/next-navigation.tsx') },
      { find: /^next\/link$/, replacement: resolve(import.meta.dirname, 'shims/next-link.tsx') },
      { find: /^next\/dynamic$/, replacement: resolve(import.meta.dirname, 'shims/next-dynamic.tsx') },
      { find: /^@bprogress\/next/, replacement: resolve(import.meta.dirname, 'shims/bprogress.tsx') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  server: { fs: { strict: false } },
});
