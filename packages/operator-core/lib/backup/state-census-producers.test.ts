import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db-encryption', () => ({ dbEncryptionKeyFilePath: () => '/mounted/secrets/db-key' }));
vi.mock('../superuser-token', () => ({ superuserTokenPath: () => '/scoped/home/superuser-token' }));
import { secretCensusProducers } from './state-census-producers';

afterEach(() => vi.clearAllMocks());
describe('secret census producer adapters', () => {
  it('uses producer-resolved paths rather than assuming both secrets live in the default home', () => {
    const result = secretCensusProducers();
    expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home']);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
      .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token']]);
  });
});
