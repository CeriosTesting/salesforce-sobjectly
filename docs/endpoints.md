# Endpoint coverage

The client has typed helpers for the resources below. Everything else under `/services/data/vXX.X/` (and `/services/apexrest/`) is reachable with `sf.request<T>()`, which handles auth, errors, retries and hooks in the same way.

## Typed helpers

| Area              | Resource                                                                   | Helper                                                                                   |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Org               | `GET /services/data/`                                                      | `sf.versions()`                                                                          |
|                   | `GET /`                                                                    | `sf.resources()`                                                                         |
|                   | `GET /limits`, `/limits/recordCount`                                       | `sf.limits()`, `sf.recordCount()`                                                        |
| sObjects          | `GET /sobjects`                                                            | `sf.describeGlobal()`                                                                    |
|                   | `GET /sobjects/{name}`, `/describe`                                        | `sobject(name).basicInfo()`, `.describe()`                                               |
|                   | `POST /sobjects/{name}`                                                    | `.create()`                                                                              |
|                   | `GET/PATCH/DELETE /sobjects/{name}/{id}`                                   | `.get()`, `.update()`, `.delete()`                                                       |
|                   | `GET/PATCH /sobjects/{name}/{field}/{value}`                               | `.getByExternalId()`, `.upsert()`                                                        |
|                   | `GET /sobjects/{name}/deleted`, `/updated`                                 | `.getDeleted()`, `.getUpdated()`                                                         |
|                   | `GET /sobjects/{name}/{id}/{blobField}`                                    | `.getBlob()`                                                                             |
| Query             | `GET /query`, `/queryAll`, `nextRecordsUrl`                                | `sf.query()`, `sf.queryMore()`, `sf.iterate()`, `sf.collect()`                           |
| Search            | `GET /search`                                                              | `sf.search.sosl()`                                                                       |
|                   | `POST /parameterizedSearch`                                                | `sf.search.parameterized()`                                                              |
|                   | `GET /search/suggestions`                                                  | `sf.search.suggestions()`                                                                |
| Composite         | `POST /composite`                                                          | `sf.composite.execute()`                                                                 |
|                   | `POST /composite/batch`                                                    | `sf.composite.batch()`                                                                   |
|                   | `POST /composite/tree/{name}`                                              | `sf.composite.tree()`                                                                    |
|                   | `POST /composite/graph`                                                    | `sf.composite.graph()`                                                                   |
|                   | `/composite/sobjects` (create, update, upsert, delete, retrieve)           | `sf.collections.*`                                                                       |
| Invocable actions | `GET /actions/standard`, `/actions/custom/{type}`                          | `sf.actions.listStandard()`, `.listCustom()`                                             |
|                   | `GET/POST /actions/standard/{name}`, `/actions/custom/{type}/{name}`       | `.describe*()`, `.invokeStandard()`, `.invokeCustom()`, `.invokeFlow()`, `.invokeApex()` |
| Tooling API       | `/tooling/query`, `/tooling/sobjects/...`                                  | `sf.tooling.query()`, `.sobject()`, `.describeGlobal()`                                  |
|                   | `/tooling/executeAnonymous`                                                | `sf.tooling.executeAnonymous()`                                                          |
|                   | `/tooling/runTestsSynchronous`, `/runTestsAsynchronous`                    | `sf.tooling.runTests*()`                                                                 |
| Apex REST         | `/services/apexrest/...`                                                   | `sf.apexRest()`                                                                          |
| Bulk API 2.0      | `/jobs/ingest` lifecycle and results                                       | `sf.bulk.ingest()`, `.createIngestJob()`, `.ingestJob()`                                 |
|                   | `/jobs/query` lifecycle and results                                        | `sf.bulk.query()`, `.createQueryJob()`, `.queryJob()`                                    |
| OAuth             | `POST /services/oauth2/token`                                              | `clientCredentials()`, `jwtBearer()`, `refreshToken()`                                   |
| Platform events   | `POST /sobjects/{event__e}`, composite                                     | `sf.events.publish()`                                                                    |
| Approvals         | `GET/POST /process/approvals`                                              | `sf.approvals.list()`, `.submit()`, `.approve()`, `.reject()`, `.pending()`              |
| Quick actions     | `/sobjects/{name}/quickActions/...`, `/quickActions/...`                   | `sobject(name).quickActions.*`, `sf.quickActions.*`                                      |
| UI API            | `/ui-api/object-info`, `/picklist-values`, `/records`, `/layout`           | `sf.uiApi.objectInfo()`, `.picklistValues()`, `.record()`, `.layout()`                   |
| Record types      | describe `recordTypeInfos`, UI API picklists                               | `sobject(name).recordTypeId()`, `.picklistValues()`                                      |
| Files             | `ContentVersion` (JSON or multipart), `VersionData`, `ContentDocumentLink` | `sf.files.upload()`, `.download()`, `.newVersion()`, `.link()`                           |
| Reports           | `/analytics/reports/{id}`, `/describe`, `/instances`                       | `sf.reports.run()`, `.runAsync()`, `.waitForInstance()`, `.describe()`, `.toRows()`      |
| Query plan        | `GET /query?explain=`                                                      | `sf.explain()`                                                                           |

## Available through `sf.request()` only

These resources have no helper yet. Response types for many of them are not exported.

- UI API list views, record create/update via UI API (`/ui-api/list-ui`, `/ui-api/records` POST/PATCH)
- Connect REST and Chatter (`/connect/...`, `/chatter/...`)
- Dashboards (`/analytics/dashboards`), CRM Analytics (`/wave/...`)
- Process rules (`/process/rules`)
- List views (`/sobjects/{name}/listviews/...`), layouts (`/sobjects/{name}/describe/layouts`)
- Recent items, tabs, theme, app menu, event log files, knowledge, consent, scheduling
- Named queries (`/named/query/...`)
- Multipart uploads for blob objects other than ContentVersion (Attachment, Document)

## Not supported

- Subscribing to events: Streaming API, Pub/Sub API and Change Data Capture (they are not REST; publishing is supported)
- SOAP API, including SOAP `login()`, which Salesforce is retiring
- Metadata API deploy/retrieve (SOAP), and Bulk API 1.0
