import { docs } from '@/.source/server';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

export const internalSource = loader({
  baseUrl: '/internal/docs',
  source: docs.toFumadocsSource(),
});
