import { describe, it, expect } from 'vitest';
import {
  PROJECT_FILES_TO_COPY,
  STATE_FILES_FOR_RESET,
  STATE_FILES_FOR_BACKUP,
  TEMPLATE_DETECT_FILES,
  SOURCE_FILES_FOR_FORK,
  SCANNED_FILES_FOR_INDEX,
  SNAPSHOT_FILES,
} from './harness-state-files';

const ALL_LISTS = {
  PROJECT_FILES_TO_COPY,
  STATE_FILES_FOR_RESET,
  STATE_FILES_FOR_BACKUP,
  TEMPLATE_DETECT_FILES,
  SOURCE_FILES_FOR_FORK,
  SCANNED_FILES_FOR_INDEX,
  SNAPSHOT_FILES,
};

describe('harness-state-files lists', () => {
  it('no list contains duplicate entries', () => {
    for (const [name, list] of Object.entries(ALL_LISTS)) {
      expect(new Set(list).size, name).toBe(list.length);
    }
  });

  it('every entry is a non-empty string', () => {
    for (const list of Object.values(ALL_LISTS)) {
      for (const f of list) {
        expect(typeof f).toBe('string');
        expect(f.length).toBeGreaterThan(0);
      }
    }
  });

  it('the backup set is a subset of the reset set (you never overwrite without backing up)', () => {
    const reset = new Set<string>(STATE_FILES_FOR_RESET);
    for (const f of STATE_FILES_FOR_BACKUP) expect(reset.has(f)).toBe(true);
  });

  it('SNAPSHOT_FILES captures the durable feature state', () => {
    expect(SNAPSHOT_FILES).toContain('features.json');
    expect(SNAPSHOT_FILES).toContain('validation-contract.md');
  });

  it('fork/template no longer seed SPEC.md as a copied project root (retired), only AGENTS.md', () => {
    expect(PROJECT_FILES_TO_COPY).toEqual(['AGENTS.md']);
    expect(PROJECT_FILES_TO_COPY).not.toContain('SPEC.md');
  });
});
