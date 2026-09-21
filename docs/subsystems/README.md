# Subsystem map

- [Client](client.md): static app, identity, API boundary, route snapshots, views.
- [Integration](integration.md): Apps Script adapter, authentication, operation policies, projections.
- [Workbook](workbook.md): tab schema, codecs, repositories, audits, revisions, migration loading.
- [Scheduling](scheduling.md): availability, deterministic ranking, preview and publication.
- [Self service](self-service.md): volunteer availability, exceptions, cancellation, notifications.
- [Imports and insights](imports-and-insights.md): staged WhenIsGood data and revision-bound derived capacity.
- [Centers](centers.md): tenant-scoped candidate intervals, advisory coverage, administrator confirmation.

Cross-cutting architecture belongs in `../architecture.md`; this directory records module ownership and contracts that maintainers need while changing code.

