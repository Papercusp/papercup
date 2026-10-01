/**
 * consent-csp (WI-10004470): the consent page's form-action must admit the redirect its answer
 * sends the browser to. The evaluator cases are calibrated against a real headless Chromium run
 * (2026-10-01, verdict): a form on http://127.0.0.1:48039 answered with a 303 to
 * http://127.0.0.1:55137/callback. Under `form-action 'self'` the browser stayed on the page and
 * the callback never ran; with the callback origin added, the callback received code+state.
 */
import { describe, expect, it } from 'vitest';
import { consentPageCsp, cspAdmitsFormTarget, formActionDirective, formActionSourceFor } from './consent-csp';

const PAGE = 'http://127.0.0.1:48039/A';
const CALLBACK = 'http://127.0.0.1:55137/callback?code=cB&state=sB';

describe('cspAdmitsFormTarget (calibrated against Chromium)', () => {
  it("refuses the cross-origin hop under form-action 'self', as the browser did", () => {
    expect(cspAdmitsFormTarget("default-src 'none'; form-action 'self'", PAGE, CALLBACK)).toBe(false);
  });

  it('admits it once the callback origin is listed, as the browser did', () => {
    expect(cspAdmitsFormTarget("default-src 'none'; form-action 'self' http://127.0.0.1:55137", PAGE, CALLBACK)).toBe(true);
  });

  it('matches scheme, host and port exactly, with default ports and the http→https upgrade', () => {
    const csp = "form-action 'self' https://claude.ai";
    expect(cspAdmitsFormTarget(csp, 'https://app.papercusp.com/x', 'https://claude.ai/api/mcp/auth_callback?code=1')).toBe(true);
    expect(cspAdmitsFormTarget(csp, 'https://app.papercusp.com/x', 'https://claude.ai:8443/cb')).toBe(false);
    expect(cspAdmitsFormTarget(csp, 'https://app.papercusp.com/x', 'https://evil.claude.ai.example/cb')).toBe(false);
    expect(cspAdmitsFormTarget("form-action http://127.0.0.1:1", PAGE, 'http://127.0.0.1:2/cb')).toBe(false);
    expect(cspAdmitsFormTarget("form-action 'self'", 'http://a.example/p', 'https://a.example/q')).toBe(true);
    expect(cspAdmitsFormTarget("form-action 'none'", PAGE, `${PAGE}?x`)).toBe(false);
    expect(cspAdmitsFormTarget("default-src 'none'", PAGE, CALLBACK)).toBe(true);
    expect(cspAdmitsFormTarget("form-action cursor:", PAGE, 'cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
  });
});

describe('the consent page CSP', () => {
  it('admits exactly the redirect origin of the request being decided', () => {
    for (const redirect of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'http://127.0.0.1:57042/callback',
      'http://localhost:43117/callback',
    ]) {
      const csp = consentPageCsp([redirect]);
      expect(cspAdmitsFormTarget(csp, 'https://app.papercusp.com/api/workspaces/ws-1/oauth/consent', `${redirect}?code=c&state=s`), csp).toBe(true);
      expect(cspAdmitsFormTarget(csp, 'https://app.papercusp.com/api/workspaces/ws-1/oauth/consent', 'https://attacker.example/x')).toBe(false);
    }
  });

  it("keeps form-action 'self' alone when the page redirects nowhere, and keeps the other directives", () => {
    expect(consentPageCsp()).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    expect(consentPageCsp(['https://claude.ai/cb'], ["base-uri 'none'"])).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it('never lets a redirect value break out of its directive', () => {
    expect(formActionSourceFor('not a url')).toBeNull();
    expect(formActionSourceFor('https://x.example;script-src *')).toBeNull();
    expect(formActionSourceFor('https://x.example/cb;script-src *')).toBe('https://x.example');
    expect(formActionSourceFor('http://[::1]:5000/cb')).toBe('http:');
    expect(formActionSourceFor('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('cursor:');
    expect(formActionDirective(['https://a.example/1', 'https://a.example/2', 'bogus'])).toBe("form-action 'self' https://a.example");
  });
});
