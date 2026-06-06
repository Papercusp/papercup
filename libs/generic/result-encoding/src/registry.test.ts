import { describe, it, expect, afterEach } from 'vitest';
import {
  configurePrePromptRegistry,
  clearPrePromptRegistry,
  getPrePromptEntry,
  listPrePromptEntries,
  readPrePromptFormat,
  isWritePositional,
} from './index';

afterEach(() => clearPrePromptRegistry());

describe('pre-prompt registry — configurable singleton', () => {
  it('defaults: read=csv, write=off', () => {
    configurePrePromptRegistry([{ name: 'coord:inbox' }]);
    const e = getPrePromptEntry('coord:inbox');
    expect(e?.read).toBe('csv');
    expect(e?.write).toBe('off');
    expect(readPrePromptFormat('coord:inbox')).toBe('csv');
    expect(isWritePositional('coord:inbox')).toBe(false);
  });

  it('write=positional opts the tool into the shim', () => {
    configurePrePromptRegistry([{ name: 'work_items:set_state', write: 'positional' }]);
    expect(isWritePositional('work_items:set_state')).toBe(true);
  });

  it('read=off leaves the tool on the default path', () => {
    configurePrePromptRegistry([{ name: 'x:y', read: 'off', write: 'positional' }]);
    expect(readPrePromptFormat('x:y')).toBeUndefined();
    expect(isWritePositional('x:y')).toBe(true);
  });

  it('unregistered tools are not pre-prompted', () => {
    configurePrePromptRegistry([{ name: 'a:b' }]);
    expect(getPrePromptEntry('c:d')).toBeUndefined();
    expect(readPrePromptFormat('c:d')).toBeUndefined();
    expect(isWritePositional('c:d')).toBe(false);
  });

  it('reconfigure replaces the prior list; preserves curation order', () => {
    configurePrePromptRegistry([{ name: 'a:b' }, { name: 'c:d' }]);
    configurePrePromptRegistry([{ name: 'e:f' }, { name: 'g:h' }]);
    expect(listPrePromptEntries().map((e) => e.name)).toEqual(['e:f', 'g:h']);
  });
});
