import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

/** Public Papercusp documentation. Initially scaffolded; authored over time. */
export const docs = defineDocs({
  dir: 'content/docs',
});

/** Internal engineering reference. Loopback-gated at /internal/docs. */
export const internalDocs = defineDocs({
  dir: 'content/internal-docs',
});

export default defineConfig();
