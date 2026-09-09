import { afterEach, describe, expect, it } from 'vitest';
import {
  readServerVintage,
  resetServerVintageResolver,
} from '@papercusp/agent-mcp';
import './server-vintage-wiring';

afterEach(() => resetServerVintageResolver());

describe('server-vintage Papercusp wiring', () => {
  it('advertises the staging operator as the current-source recovery route', () => {
    const vintage = readServerVintage();
    expect(vintage?.freshCodeEndpoint).toBe(
      'the Papercusp staging operator at :3170 (with ptool, pass --port=3170 explicitly)',
    );
  });
});
