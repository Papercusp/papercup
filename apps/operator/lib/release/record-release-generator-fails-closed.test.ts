// EI-20594446930640654 — the site GENERATOR must refuse on the same input its GATE refuses on.
//
// WHY THIS TEST EXISTS
// record-release-cli --regenerate and gate-release-site both depend on
// PAPERCUSP_RELEASE_OWNER_NAME, and they used to handle its ABSENCE in opposite
// directions: the gate exited 2 with "REFUSING TO CERTIFY", while the generator
// exited 0, printed "regenerated N page(s)", and wrote HTML with the owner's name
// embedded in it. The component that CREATED the leak was silent; only the component
// that CHECKED for it failed closed.
//
// Measured: a regenerate with no owner env exited 0 after 235s and looked completely
// successful. The leak surfaced only at a publish gate three steps later, and only
// because the env happened to be set for that step and not this one. Pass it to both
// steps and you never learn the trap exists.
//
// WHAT IS ASSERTED, AND WHY IT IS THE FAILURE AND NOT THE OUTPUT
// This asserts the run FAILS. It deliberately does NOT assert "the emitted site is
// clean": once the fix is in place the generator emits nothing at all, so a
// cleanliness assertion would pass trivially — and would have passed just as happily
// against the ORIGINAL bug if the fixture happened to contain no owner tag. Asserting
// the refusal is the only form that can distinguish the fixed code from the broken code.

import { describe, expect, it, vi } from 'vitest';

describe('record-release-cli generator fails closed without an owner literal', () => {
  it('REFUSES to render when no owner-name literal resolves', async () => {
    // identityLiterals() resolves the owner name from OWNER_NAME_ENV, or not at all —
    // git config is deliberately never trusted for the NAME (an automated box's
    // committer is by construction not the owner). Stubbing the module to report "no
    // owner literal" is exactly the state a box with an unset env / bot identity is in.
    vi.doMock('./release-content-scrub', async () => {
      const actual =
        await vi.importActual<typeof import('./release-content-scrub')>('./release-content-scrub');
      return { ...actual, identityLiterals: () => [], hasOwnerNameLiteral: () => false };
    });

    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.join(' '));
    });

    try {
      const { regenerateOnly } = await import('./record-release-cli');
      // An out dir that does NOT exist: if the guard ever regresses, the call proceeds
      // to real rendering and fails for some unrelated reason instead of returning 1 —
      // so a green result here cannot come from an accidental early error.
      const code = await regenerateOnly('desktop' as never, '/nonexistent/pc-should-never-render');

      expect(code, 'generator must exit NON-ZERO when it cannot redact the owner name').not.toBe(0);
      expect(errors.join('\n')).toMatch(/REFUSING TO RENDER/);
      // The message must name the remedy, not merely complain: this is the one env var
      // that makes the scrub functional, and the operator hitting this needs it.
      expect(errors.join('\n')).toMatch(/PAPERCUSP_RELEASE_OWNER_NAME/);
    } finally {
      spy.mockRestore();
      vi.doUnmock('./release-content-scrub');
      vi.resetModules();
    }
  });

  it('CONTROL: the real module does resolve a literal when the env is set', async () => {
    // Guards the guard. If identityLiterals stopped reading OWNER_NAME_ENV entirely,
    // the test above would pass for the wrong reason — the generator would refuse
    // ALWAYS, including on a correctly-configured box, and this control would catch it.
    vi.resetModules();
    const prev = process.env.PAPERCUSP_RELEASE_OWNER_NAME;
    process.env.PAPERCUSP_RELEASE_OWNER_NAME = 'Zed';
    try {
      const { identityLiterals, hasOwnerNameLiteral } = await import('./release-content-scrub');
      expect(hasOwnerNameLiteral(identityLiterals())).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_RELEASE_OWNER_NAME;
      else process.env.PAPERCUSP_RELEASE_OWNER_NAME = prev;
    }
  });
});
