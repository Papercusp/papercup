# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> auth e2e >> /api/auth/me returns 200 even when PG is unavailable
- Location: e2e/auth.spec.ts:12:7

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED ::1:3055
Call log:
  - → GET http://localhost:3055/api/auth/me
    - user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36
    - accept: */*
    - accept-encoding: gzip,deflate,br

```