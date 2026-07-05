# @papercusp/hive-app-seam

Host-injected seam for agentic apps that keep deterministic app state separate
from a judgment hive.

The package provides three app-facing operations:

- `bootstrapHives()` ensures the domain hive and ops hive exist once per stable
  fingerprint marker.
- `enqueueWorkItems()` turns deterministic app requests into host work items.
- `startIngestLoop()` parses judged hive output events and stores accepted
  results through an injected storage port.

It imports no Papercusp operator internals. A host app supplies adapters for
hive creation, marker storage, work-item enqueue, and ingest storage.

## Template Consumption

In a materialized app that vendors the Papercusp generic libs beside the app:

```json
{
  "dependencies": {
    "@papercusp/hive-app-seam": "file:../libs/generic/hive-app-seam"
  }
}
```

If the template copies reusable libs into `vendor/papercusp/`, use the copied
path instead:

```json
{
  "dependencies": {
    "@papercusp/hive-app-seam": "file:./vendor/papercusp/hive-app-seam"
  }
}
```

The package is intentionally framework-neutral; React, Tauri, Hono, or CLI apps
all consume the same seam and wire different host adapters.
