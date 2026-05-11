// Batch H8 — OAuth round-trip smoke for the iframe:navigate cap.
//
// Mocks a Stripe Connect-style OAuth handshake from the iframe SDK's
// perspective:
//   1. iframe sends iframe-navigate to https://connect.stripe.com/oauth/authorize?...
//      → operator parent allows because manifest declared the origin
//   2. iframe sends iframe-navigate to https://evil.example.com/...
//      → operator parent denies (origin not in declared set)
//   3. iframe sends iframe-navigate with malformed URL
//      → returns null (denied)
//   4. wildcard '*' in navigateOrigins permits any origin (escape hatch
//      with explicit user opt-in at install time)
//
// Real Stripe sandbox is not required — the cap-check is pure: parse
// URL → match origin string → allow/deny. Stripe URL is just a
// representative shape.

import { isNavigateAllowed } from '../lib/PluginIframe.tsx';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
};

console.log('# OAuth round-trip — Stripe Connect shape');
const stripeOrigins = ['https://connect.stripe.com'];

const stripeAuthURL = 'https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_test_x&scope=read_write&state=abc123&redirect_uri=https%3A%2F%2Foperator.papercusp%2Fplugins%2Fstripe-connect%2Fcallback';
const allowed = isNavigateAllowed(stripeOrigins, stripeAuthURL);
ok(allowed !== null, 'declared origin is allowed');
ok(allowed?.origin === 'https://connect.stripe.com', 'parsed origin matches');
ok(allowed?.pathname === '/oauth/authorize', 'pathname preserved');

console.log('# Origin not declared → denied');
ok(isNavigateAllowed(stripeOrigins, 'https://evil.example.com/redirect') === null, 'evil origin denied');
ok(isNavigateAllowed(stripeOrigins, 'https://connect.stripe.com.evil.com/x') === null, 'similar-looking domain denied');
// Subdomain of allowed origin: allowed list is exact origin match (no wildcards).
ok(isNavigateAllowed(stripeOrigins, 'https://api.connect.stripe.com/x') === null, 'subdomain not auto-allowed');

console.log('# Malformed URLs → null (denied)');
ok(isNavigateAllowed(stripeOrigins, 'not-a-url') === null, 'non-URL denied');
ok(isNavigateAllowed(stripeOrigins, '') === null, 'empty string denied');
ok(isNavigateAllowed(stripeOrigins, 'javascript:alert(1)') !== null === false, 'javascript: scheme is parseable but not an http origin');
// javascript: URLs do parse via new URL() but their .origin is "null".
// They should never match a declared http(s) origin — verify.
const jsUrl = isNavigateAllowed(stripeOrigins, 'javascript:alert(1)');
ok(jsUrl === null, 'javascript: scheme denied (origin "null" never matches https://...)');

console.log('# Wildcard "*" — explicit escape hatch');
ok(isNavigateAllowed(['*'], 'https://anywhere.example.com/x') !== null, 'wildcard allows any origin');
ok(isNavigateAllowed(['*'], 'https://evil.example.com/x') !== null, 'wildcard allows even untrusted origins');
ok(isNavigateAllowed(['*'], 'not-a-url') === null, 'wildcard still rejects malformed URLs');

console.log('# Empty allowlist denies everything');
ok(isNavigateAllowed([], 'https://connect.stripe.com/x') === null, 'empty allowlist denies declared-elsewhere');

console.log('# Multi-origin allowlist');
const multi = ['https://connect.stripe.com', 'https://accounts.google.com', 'https://github.com'];
ok(isNavigateAllowed(multi, 'https://github.com/login') !== null, 'github allowed');
ok(isNavigateAllowed(multi, 'https://accounts.google.com/o/oauth2/v2/auth') !== null, 'google allowed');
ok(isNavigateAllowed(multi, 'https://gitlab.com/login') === null, 'gitlab denied');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
