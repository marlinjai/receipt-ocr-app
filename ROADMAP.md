# Roadmap

## Planned

<!-- Decided features, ready to be worked on -->

- Migrate the `/api/*` `SERVICE_TOKEN` machine path to tenant-scoped auth-brain
  API keys. Deferred out of the app-grant door flip (that slice left the shared
  `SERVICE_TOKEN` bearer unchanged); machine callers should carry a
  tenant-scoped key so their access is entitlement-checked like browser sessions.

## In Progress

<!-- Currently being implemented -->

## Completed

<!-- Done — move to CHANGELOG.md on release -->

