import { docs, internalDocs } from '@/.source/server';
import { loader } from 'fumadocs-core/source';

/**
 * Public Papercusp docs — served at /docs, exposed to every agent via
 * docs:* tools. Currently scaffolded (a placeholder index until the
 * public site is authored). Engineering content lives at /internal/docs.
 */
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

/**
 * Internal engineering reference — served at /internal/docs, gated to
 * loopback (see proxy.ts). NOT exposed as agent tools; for human/dev
 * readers and (later) operator/oracle/documenter principals working on
 * Papercusp itself via an internal_docs:* tool surface.
 */
export const internalSource = loader({
  baseUrl: '/internal/docs',
  source: internalDocs.toFumadocsSource(),
});
