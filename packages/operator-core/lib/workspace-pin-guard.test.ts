/**
 * workspacePinWarning — fires only when PAPERCUSP_WORKSPACE_ID is set to a
 * non-empty value, and names the pinned workspace in the warning.
 */
import { describe, expect, it } from 'vitest';
import { workspacePinWarning } from './workspace-pin-guard';

describe('workspacePinWarning', () => {
  it('returns null when the pin is absent', () => {
    expect(workspacePinWarning({})).toBeNull();
  });

  it('returns null when the pin is empty or whitespace', () => {
    expect(workspacePinWarning({ PAPERCUSP_WORKSPACE_ID: '' })).toBeNull();
    expect(workspacePinWarning({ PAPERCUSP_WORKSPACE_ID: '   ' })).toBeNull();
  });

  it('warns and names the pinned workspace when set', () => {
    const w = workspacePinWarning({ PAPERCUSP_WORKSPACE_ID: 'default' });
    expect(w).not.toBeNull();
    expect(w).toContain('PAPERCUSP_WORKSPACE_ID=default');
    expect(w).toContain('PINS workspace');
  });

  it('trims surrounding whitespace in the reported value', () => {
    const w = workspacePinWarning({ PAPERCUSP_WORKSPACE_ID: '  papercusp-workspace  ' });
    expect(w).toContain("=papercusp-workspace ");
    expect(w).toContain("'papercusp-workspace'");
  });
});
