# @papercusp/pot-app-seam

Host-injected seam for agentic apps that keep deterministic app state separate
from a judgment pot.

The package provides three app-facing operations:

- `bootstrapHives()` ensures the domain pot and ops pot exist once per stable
  fingerprint marker.
- `enqueueWorkItems()` turns deterministic app requests into host work items.
- `startIngestLoop()` parses judged pot output events and stores accepted
  results through an injected storage port.

It imports no Papercusp operator internals. A host app supplies adapters for
pot creation, marker storage, work-item enqueue, and ingest storage.

## Template Consumption

In a materialized app that vendors the Papercusp generic libs beside the app:

```json
{
  "dependencies": {
    "@papercusp/pot-app-seam": "file:../libs/generic/hive-app-seam"
  }
}
```

If the template copies reusable libs into `vendor/papercusp/`, use the copied
path instead:

```json
{
  "dependencies": {
    "@papercusp/pot-app-seam": "file:./vendor/papercusp/pot-app-seam"
  }
}
```

The package is intentionally framework-neutral; React, Tauri, Hono, or CLI apps
all consume the same seam and wire different host adapters.
