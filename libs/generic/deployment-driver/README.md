# @papercusp/deployment-driver

Provider-agnostic deployment abstraction. "Deploying" a harness moves its
**execution plane** onto a **frame** (a machine the driver controls) that joins
the harness/Pot as a headless federated peer.

```ts
import {
  resolveDeploymentDriver,
  isLocalDeployment,
  configureDeployment,
  type DeploymentConfig,
  type DeploymentDriver,
} from '@papercusp/deployment-driver';

// Host bootstrap: register cloud backends (LocalDriver is built-in).
configureDeployment({ drivers: [LatitudeDriver] });

// At instantiation / dispatch:
const cfg: DeploymentConfig = { target: 'latitude', region: 'NYC', kind: 'vm' };
if (!isLocalDeployment(cfg)) {
  const driver = resolveDeploymentDriver(cfg);
  const frame = await driver.provision(cfg, ctx);
  await driver.install(frame, cfg, ctx);
  await driver.join(frame, cfg, ctx);
  // … run … then
  await driver.teardown(frame, cfg, ctx); // DESTROY for cloud → ends billing
}
```

## Model

- **`DeploymentConfig`** — a sibling input to the blueprint (NOT a blueprint
  property; D-001). `target` selects the driver; provider-specific fields live
  under `provider`.
- **`DeploymentDriver`** — `provision` / `install` / `join` / `teardown` over a
  `Frame`. `local` is the trivial built-in no-op (the machine is already here);
  every cloud backend implements the same four verbs and registers via the
  `configure*()` seam.
- **`Frame`** — a handle to a provisioned machine; persisted host-side so
  teardown survives process restarts.

Generic + host-clean: names no provider except `local`, zero runtime deps. Each
backend narrows + validates its own `provider` block host-side. Part of
`cloud-deployment-layer-2026-06-06` (P-001/D-002).
