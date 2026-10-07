---
"@cerios/salesforce-sobjectly": minor
---

`sf.composite.batch()` takes a typed builder, like `execute()`: paths, bodies and results are checked against the registry, SOQL builder queries give typed records, and `result.get(result.refs.x)` reads each result. The batch builder also has `limits()`, `search()`, and `createWithBlob()` / `updateWithBlob()` or a `binary` part on `request()` to upload files in a multipart batch. The array form still works. Both forms take a `timeoutMs` option, because Salesforce allows a batch to run for up to 10 minutes.

The composite, graph and batch builders share new typed subrequests: `getByExternalId`, `children`, `parent`, `queryAll`, `describe`, `basicInfo`, `getDeleted` and `getUpdated`. Composite requests can hold sObject Collections subrequests (`createMany`, `updateMany`, `upsertMany`, `deleteMany`, `retrieveMany`) that reference earlier results. `composite.graph()` returns each graph's refs, in input order.

New endpoint helpers: `sobject(name).children()` / `.parent()`, list views (`listViews`, `recentListViews`, `listViewDescribe`, `listViewResults`), layouts (`layouts`, `compactLayouts`, `approvalLayouts`), `sf.recentlyViewed()` and `sf.users` (`passwordExpired`, `setPassword`, `resetPassword`).

The array form of `batch()` no longer doubles the version when a path starts with `/services/data/vXX.X/`.
