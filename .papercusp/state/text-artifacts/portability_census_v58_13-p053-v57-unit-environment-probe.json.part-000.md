---
rel_path: "portability/census/v58/13-p053-v57-unit-environment-probe.json.part-000"
updated_at: 1794252348729
_body: "content"
---

{
  "scope": "installed systemd EnvironmentFile references within two retained home roots; definition reads and file metadata only, no credential bytes",
  "wholeInstallVerified": false,
  "roots": [
    {
      "id": "home-state",
      "path": "/home/marsh-office/.papercusp"
    },
    {
      "id": "home-config",
      "path": "/home/marsh-office/.config/papercusp"
    }
  ],
  "unitDeclarationCount": 1488,
  "declarations": [],
  "retainedEnvFiles": [
    "/home/marsh-office/.papercusp/app-producer.env",
    "/home/marsh-office/.papercusp/build-vms.env",
    "/home/marsh-office/.papercusp/dht-liveness.env",
    "/home/marsh-office/.papercusp/gcs-artifacts-worker-dev.env",
    "/home/marsh-office/.papercusp/p014-cut-0809e.env",
    "/home/marsh-office/.papercusp/posthog-deploy.env",
    "/home/marsh-office/.papercusp/r2.env",
    "/home/marsh-office/.papercusp/release-host-gcs.env",
    "/home/marsh-office/.papercusp/release-host.env",
    "/home/marsh-office/.papercusp/release-identity.env",
    "/home/marsh-office/.papercusp/release-storage.env",
    "/home/marsh-office/.config/papercusp/android-ci.env",
    "/home/marsh-office/.config/papercusp/cloud-prod-secrets.env",
    "/home/marsh-office/.config/papercusp/hosted-control-plane.env",
    "/home/marsh-office/.config/papercusp/portal-public-links.env"
  ],
  "before": {
    "/home/marsh-office/.papercusp/app-producer.env": {
      "dev": 66307,
      "ino": 18145627,
      "mode": 33152,
      "size": 473,
      "atimeMs": 1794101377774.5728,
      "mtimeMs": 1788066971733.5532,
      "ctimeMs": 1788066971735.4053,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/build-vms.env": {
      "dev": 66307,
      "ino": 18143465,
      "mode": 33152,
      "size": 422,
      "atimeMs": 1793936542647.7168,
      "mtimeMs": 1783900945499.418,
      "ctimeMs": 1783900945501.418,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/dht-liveness.env": {
      "dev": 66307,
      "ino": 18148032,
      "mode": 33152,
      "size": 539,
      "atimeMs": 1794251700182.299,
      "mtimeMs": 1786930079983.6882,
      "ctimeMs": 1786930079986.6885,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/gcs-artifacts-worker-dev.env": {
      "dev": 66307,
      "ino": 18406006,
      "mode": 33152,
      "size": 2445,
      "atimeMs": 1794235297249.3816,
      "mtimeMs": 1792818998476.096,
      "ctimeMs": 1792818998769.578,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/p014-cut-0809e.env": {
      "dev": 66307,
      "ino": 18109395,
      "mode": 33152,
      "size": 83,
      "atimeMs": 1794101356292.775,
      "mtimeMs": 1786257031786.5913,
      "ctimeMs": 1786257031788.5916,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/posthog-deploy.env": {
      "dev": 66307,
      "ino": 18103582,
      "mode": 33152,
      "size": 323,
      "atimeMs": 1793936610302.4087,
      "mtimeMs": 1778640546228.6184,
      "ctimeMs": 1778640546229.6184,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/r2.env": {
      "dev": 66307,
      "ino": 18143185,
      "mode": 33152,
      "size": 770,
      "atimeMs": 1793936879813.0022,
      "mtimeMs": 1783882136216.7146,
      "ctimeMs": 1783882136220.7146,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-host-gcs.env": {
      "dev": 66307,
      "ino": 18510308,
      "mode": 33152,
      "size": 225,
      "atimeMs": 1794213996563.0796,
      "mtimeMs": 1793043168889.293,
      "ctimeMs": 1793043168889.293,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-host.env": {
      "dev": 66307,
      "ino": 20190995,
      "mode": 33152,
      "size": 5749,
      "atimeMs": 1794211390131.653,
      "mtimeMs": 1793121775495.0947,
      "ctimeMs": 1793121775497.0317,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-identity.env": {
      "dev": 66307,
      "ino": 18192393,
      "mode": 33152,
      "size": 109,
      "atimeMs": 1794211381813.1167,
      "mtimeMs": 1790727506255.5962,
      "ctimeMs": 1790727506432.3123,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-storage.env": {
      "dev": 66307,
      "ino": 18510283,
      "mode": 33152,
      "size": 58,
      "atimeMs": 1794167113839.1538,
      "mtimeMs": 1793043168888.7512,
      "ctimeMs": 1793043168888.7512,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/android-ci.env": {
      "dev": 66307,
      "ino": 7788050,
      "mode": 33204,
      "size": 203,
      "atimeMs": 1794171496531.9001,
      "mtimeMs": 1791397140123.1077,
      "ctimeMs": 1791397140123.1077,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/cloud-prod-secrets.env": {
      "dev": 66307,
      "ino": 7733844,
      "mode": 33204,
      "size": 830,
      "atimeMs": 1794209488712.532,
      "mtimeMs": 1792001480644.936,
      "ctimeMs": 1792001480644.936,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/hosted-control-plane.env": {
      "dev": 66307,
      "ino": 7770203,
      "mode": 33204,
      "size": 3361,
      "atimeMs": 1794209488712.532,
      "mtimeMs": 1791004354129.193,
      "ctimeMs": 1791004354129.193,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/portal-public-links.env": {
      "dev": 66307,
      "ino": 7793206,
      "mode": 33152,
      "size": 446,
      "atimeMs": 1794174661209.34,
      "mtimeMs": 1791611550997.718,
      "ctimeMs": 1791611550997.718,
      "isFile": true,
      "isSymbolicLink": false
    }
  },
  "after": {
    "/home/marsh-office/.papercusp/app-producer.env": {
      "dev": 66307,
      "ino": 18145627,
      "mode": 33152,
      "size": 473,
      "atimeMs": 1794101377774.5728,
      "mtimeMs": 1788066971733.5532,
      "ctimeMs": 1788066971735.4053,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/build-vms.env": {
      "dev": 66307,
      "ino": 18143465,
      "mode": 33152,
      "size": 422,
      "atimeMs": 1793936542647.7168,
      "mtimeMs": 1783900945499.418,
      "ctimeMs": 1783900945501.418,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/dht-liveness.env": {
      "dev": 66307,
      "ino": 18148032,
      "mode": 33152,
      "size": 539,
      "atimeMs": 1794251700182.299,
      "mtimeMs": 1786930079983.6882,
      "ctimeMs": 1786930079986.6885,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/gcs-artifacts-worker-dev.env": {
      "dev": 66307,
      "ino": 18406006,
      "mode": 33152,
      "size": 2445,
      "atimeMs": 1794235297249.3816,
      "mtimeMs": 1792818998476.096,
      "ctimeMs": 1792818998769.578,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/p014-cut-0809e.env": {
      "dev": 66307,
      "ino": 18109395,
      "mode": 33152,
      "size": 83,
      "atimeMs": 1794101356292.775,
      "mtimeMs": 1786257031786.5913,
      "ctimeMs": 1786257031788.5916,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/posthog-deploy.env": {
      "dev": 66307,
      "ino": 18103582,
      "mode": 33152,
      "size": 323,
      "atimeMs": 1793936610302.4087,
      "mtimeMs": 1778640546228.6184,
      "ctimeMs": 1778640546229.6184,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/r2.env": {
      "dev": 66307,
      "ino": 18143185,
      "mode": 33152,
      "size": 770,
      "atimeMs": 1793936879813.0022,
      "mtimeMs": 1783882136216.7146,
      "ctimeMs": 1783882136220.7146,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-host-gcs.env": {
      "dev": 66307,
      "ino": 18510308,
      "mode": 33152,
      "size": 225,
      "atimeMs": 1794213996563.0796,
      "mtimeMs": 1793043168889.293,
      "ctimeMs": 1793043168889.293,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-host.env": {
      "dev": 66307,
      "ino": 20190995,
      "mode": 33152,
      "size": 5749,
      "atimeMs": 1794211390131.653,
      "mtimeMs": 1793121775495.0947,
      "ctimeMs": 1793121775497.0317,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-identity.env": {
      "dev": 66307,
      "ino": 18192393,
      "mode": 33152,
      "size": 109,
      "atimeMs": 1794211381813.1167,
      "mtimeMs": 1790727506255.5962,
      "ctimeMs": 1790727506432.3123,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.papercusp/release-storage.env": {
      "dev": 66307,
      "ino": 18510283,
      "mode": 33152,
      "size": 58,
      "atimeMs": 1794167113839.1538,
      "mtimeMs": 1793043168888.7512,
      "ctimeMs": 1793043168888.7512,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/android-ci.env": {
      "dev": 66307,
      "ino": 7788050,
      "mode": 33204,
      "size": 203,
      "atimeMs": 1794171496531.9001,
      "mtimeMs": 1791397140123.1077,
      "ctimeMs": 1791397140123.1077,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/cloud-prod-secrets.env": {
      "dev": 66307,
      "ino": 7733844,
      "mode": 33204,
      "size": 830,
      "atimeMs": 1794209488712.532,
      "mtimeMs": 1792001480644.936,
      "ctimeMs": 1792001480644.936,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/hosted-control-plane.env": {
      "dev": 66307,
      "ino": 7770203,
      "mode": 33204,
      "size": 3361,
      "atimeMs": 1794209488712.532,
      "mtimeMs": 1791004354129.193,
      "ctimeMs": 1791004354129.193,
      "isFile": true,
      "isSymbolicLink": false
    },
    "/home/marsh-office/.config/papercusp/portal-public-links.env": {
      "dev": 66307,
      "ino": 7793206,
      "mode": 33152,
      "size": 446,
      "atimeMs": 1794174661209.34,
      "mtimeMs": 1791611550997.718,
      "ctimeMs": 1791611550997.718,
      "isFile": true,
      "isSymbolicLink": false
    }
  },
  "metadataUnchanged": true
}
