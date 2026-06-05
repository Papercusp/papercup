/**
 * Day-1 runner additions: USER_VAR_* flattening + PAPERCUSP_PROJECT_DIR
 * propagation.
 */

import { describe, expect, it } from 'vitest';
import { flattenConfigToUserVars } from './runner';

describe('flattenConfigToUserVars', () => {
  it('flattens lowerCamel keys to USER_VAR_UPPER_SNAKE', () => {
    const env = flattenConfigToUserVars({
      accountId: 'abc',
      projectName: 'demo',
      r2BucketName: 'demo-assets',
    });
    expect(env).toEqual({
      USER_VAR_ACCOUNT_ID: 'abc',
      USER_VAR_PROJECT_NAME: 'demo',
      USER_VAR_R2_BUCKET_NAME: 'demo-assets',
    });
  });

  it('coerces numbers, booleans, and null', () => {
    const env = flattenConfigToUserVars({
      retries: 3,
      enabled: true,
      disabled: false,
      empty: null,
    });
    expect(env).toEqual({
      USER_VAR_RETRIES: '3',
      USER_VAR_ENABLED: 'true',
      USER_VAR_DISABLED: 'false',
      USER_VAR_EMPTY: '',
    });
  });

  it('skips non-scalar values (objects, arrays, undefined)', () => {
    const env = flattenConfigToUserVars({
      keep: 'yes',
      drop1: { nested: 'no' },
      drop2: ['arr'],
      drop3: undefined,
    });
    expect(env).toEqual({ USER_VAR_KEEP: 'yes' });
  });

  it('handles mixed-case + non-alphanumeric keys', () => {
    const env = flattenConfigToUserVars({
      'kebab-case': 'a',
      snake_case: 'b',
      'mixed.dot.path': 'c',
      ALLCAPS: 'd',
    });
    expect(env).toEqual({
      USER_VAR_KEBAB_CASE: 'a',
      USER_VAR_SNAKE_CASE: 'b',
      USER_VAR_MIXED_DOT_PATH: 'c',
      USER_VAR_ALLCAPS: 'd',
    });
  });

  it('skips empty-string keys after normalization', () => {
    const env = flattenConfigToUserVars({ '___': 'silent' });
    expect(env).toEqual({});
  });

  it('preserves existing UPPER_SNAKE-shaped keys unchanged', () => {
    const env = flattenConfigToUserVars({ DATABASE_URL: 'postgres://' });
    expect(env).toEqual({ USER_VAR_DATABASE_URL: 'postgres://' });
  });
});
