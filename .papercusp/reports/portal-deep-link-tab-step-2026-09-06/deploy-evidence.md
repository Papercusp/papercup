# Unit 4 deploy evidence (P-004) — written 2026-09-06T00:44:36Z by su-e8071

## Build+handoff chain (task 0mtp31kmy3e9xsw1jt4, log /tmp/e8071-u4-build-deploy-1.log)
CHAIN_START 2026-09-06T00:37:44Z load=179.91
HEAD=40a84531 2026-09-05T20:27:45-04:00
portal_standalone_promoting:jOs-sQ47JI9_CeUeKQxgy-20260906001850099-996475-e053c978 -> zsbDNiN5utSCRh2AV2Xdk-20260906004051562-2350753-a2e10e88
portal_standalone_promoted:/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/releases/zsbDNiN5utSCRh2AV2Xdk-20260906004051562-2350753-a2e10e88
BUILD_RC=0 2026-09-06T00:41:08Z
cloud-portal: current release source digest matches /home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal (d0641dd5ce7d…); fresh
cloud-portal: papercusp-cloud-portal.service is healthy but running a stale command; restarting onto the standalone artifact
cloud-portal: handoff complete: papercusp-cloud-portal.service runs the standalone production artifact and passed health check
DEPLOY_RC=0 2026-09-06T00:41:19Z
POST_3801 pid=2407637 cwd=releases/zsbDNiN5utSCRh2AV2Xdk-20260906004051562-2350753-a2e10e88
CHAIN_END rc=0 2026-09-06T00:41:19Z

## Release carries the fix
release zsbDNiN5utSCRh2AV2Xdk-20260906004051562: owners-registry literal 'desktops","cloud","dev' present in static/chunks/app/page-e4e96c75b2e0f76a.js (1 file); previous release jOs-sQ47JI9_CeUeKQxgy-20260906001850099: 0 files (identifiers are minified, so SURFACE_PARAM_OWNERS/operatorDeepLinkTargets by name are 0 in both — the string literal is the discriminator)
health :3081 /api/health = 200 at 2026-09-06T00:44:36Z
