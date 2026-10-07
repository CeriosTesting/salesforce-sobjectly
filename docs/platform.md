# Approvals, files, reports and more

Typed helpers for the Salesforce features that come up in integrations and tests, beyond plain records.

## Record types and picklists

Record type ids differ between orgs (production, sandboxes, scratch orgs). Resolve them by DeveloperName instead of hard-coding them:

```ts
const complaintId = await sf.sobject("Case").recordTypeId("Complaint"); // typed: only Case record types
await sf.sobject("Case").create({ Subject: "Broken", RecordTypeId: complaintId });

// Active values; with recordType only the values available for that record type
const statuses = await sf.sobject("Case").picklistValues("Status", { recordType: "Complaint" });
// [{ value: "New", label: "New", isDefault: true }, ...]  value is typed as Case["Status"]
```

Describe results are cached per client, so repeated lookups cost nothing. `sf.clearCache()` empties the cache, and `new SalesforceClient({ cache: false })` turns it off.

The generated file also exports `RECORD_TYPES` and `PICKLIST_VALUES` constants, for looping in tests without an API call. With `picklists: "const"` or `"enum"`, each picklist also gets a named constant such as `CaseStatus.Working` (see the [codegen guide](./codegen.md#picklists)).

## Relationships, list views and layouts

Related records can be read by relationship name. The names, child sObjects and fields are checked against the registry.

```ts
const contacts = await sf.sobject("Account").children(accountId, "Contacts", ["LastName", "Email"]);
contacts.records; // { LastName, Email }[] (first page)
const account = await sf.sobject("Contact").parent(contactId, "Account", ["Name"]);
```

List views and layouts:

```ts
const { listviews } = await sf.sobject("Account").listViews();
const rows = await sf.sobject("Account").listViewResults(listviews[0].id, { limit: 50 });
const describe = await sf.sobject("Account").listViewDescribe(listviews[0].id); // includes the SOQL query

await sf.sobject("Case").layouts(); // page layouts and record type mappings (layouts is null with several record types)
await sf.sobject("Case").layouts(recordTypeId); // one record type's layout
await sf.sobject("Case").compactLayouts();
await sf.sobject("Case").approvalLayouts({ approvalProcessName: "Escalation" });
```

## Recently viewed records and user passwords

```ts
const recent = await sf.recentlyViewed({ limit: 10 }); // { attributes, Id, Name }[]

await sf.users.passwordExpired(userId); // boolean
await sf.users.setPassword(userId, newPassword);
const temporary = await sf.users.resetPassword(userId); // also emails the user a reset link
```

## Platform events

```ts
await sf.events.publish("Order_Shipped__e", { Order_Number__c: "A-1" });
const results = await sf.events.publish("Order_Shipped__e", orders); // many: composite, 25 per call
results[0].uuid; // EventUuid, to correlate with subscribers
```

**How results are reported**

- Salesforce answers a successful publish with an `OPERATION_ENQUEUED` entry. `publish` treats that as success and returns its UUID.
- A rejected event throws a `SalesforceSaveError`, unless you pass `throwOnError: false`.
- With the default "Publish Immediately" behaviour, events are not rolled back.

## Approvals

```ts
await sf.approvals.submit(opportunityId, {
	comments: "Discount above 20%",
	processDefinitionNameOrId: "Discount_Approval",
});

const pending = await sf.approvals.pending(opportunityId); // work items visible to the current user
await sf.approvals.approve(opportunityId, { comments: "OK" }); // record id or work item id (04i…)
await sf.approvals.reject(workItemId, { comments: "Too high" });
const processes = await sf.approvals.list(); // per sObject
```

**How `approve` and `reject` find the work item**

- Given a record id, they look up its single pending work item.
- If there are several pending items, they throw and list them; pass the work item id instead.
- A failed step throws a `SalesforceSaveError`, unless you pass `throwOnError: false`.

## Quick actions

```ts
const actions = sf.sobject("Account").quickActions;
await actions.list();
const defaults = await actions.defaultValues("NewContact", accountId);
const result = await actions.invoke("NewContact", { LastName: "Doe" }, { contextId: accountId });
result.ids; // created record ids

await sf.quickActions.invoke("LogACall", { Subject: "Follow-up" }); // global actions
```

An sObject's `list()` also returns the global actions on its page layout, such as `NewContact` on Account. Those only exist under `/quickActions`. When the sObject has no action of that name (404), `describe`, `defaultValues` and `invoke` retry the global action.

## User Interface API

```ts
const info = await sf.uiApi.objectInfo("Account"); // fields, record types, defaults (cached)
const values = await sf.uiApi.picklistValues("Case", recordTypeId, "Status");
const record = await sf.uiApi.record("Account", id, { fields: ["Name"], optionalFields: ["Industry"] });
record.fields.Name.displayValue; // typed field names and values
const layout = await sf.uiApi.layout("Account", { mode: "Edit" });
```

- Fields in `fields` must be accessible, or the request fails.
- Fields in `optionalFields` are left out when they are not accessible.

## Files

```ts
const { contentVersionId, contentDocumentId } = await sf.files.upload({
	data: pdfBytes, // Uint8Array or string
	fileName: "invoice.pdf",
	linkTo: accountId, // optional: share with a record
});
const bytes = await sf.files.download(contentDocumentId); // or a ContentVersion id
await sf.files.newVersion(contentDocumentId, { data: updatedBytes, fileName: "invoice.pdf" });
await sf.files.link(contentDocumentId, caseId, { shareType: "C", visibility: "AllUsers" });
```

**How uploads are sent**

- Files up to about 28 MB go as JSON with base64.
- Larger files go as multipart, up to the 2 GB limit. The multipart body is built as bytes, so it works with every transport, custom ones included.

## Reports

```ts
const result = await sf.reports.run(reportId, {
	filters: [{ column: "AMOUNT", operator: "greaterThan", value: "1000" }],
});
const rows = sf.reports.toRows(result); // [{ "ACCOUNT.NAME": { label, value }, AMOUNT: { ... } }, ...]

const instance = await sf.reports.runAsync(reportId); // for slow reports
const finished = await sf.reports.waitForInstance(reportId, instance.id);
```

**Limits**

- Synchronous runs return at most the first 2,000 detail rows.
- An org can do 500 synchronous runs per hour.
- Asynchronous results stay available for 24 hours.

## Query plans

```ts
const plans = await sf.explain(sf.soql("Account").select("Id").where("Name", "=", "Acme"));
plans[0].leadingOperationType; // "Index" | "TableScan" | ...
plans[0].relativeCost; // > 1 means the filter is not selective
```

This uses Salesforce's query plan endpoint, which Salesforce marks as beta.

## Apex debug logs

`capture()` records the Apex logs a piece of work produces: triggers, flows, Apex REST, anonymous Apex. This helps when a test fails on the Salesforce side:

```ts
const { result, logs } = await sf.tooling.debugLogs.capture(() => sf.sobject("Case").create({ Subject: "Broken" }), {
	levels: { ApexCode: "FINEST", Database: "INFO" },
});
for (const log of logs) console.log(log.operation, log.status, log.body);

const run = await sf.tooling.executeAnonymous("System.debug('hello');", { captureLog: true });
run.logs[0].body; // contains USER_DEBUG|hello
```

Salesforce only accepts anonymous Apex in the URL, so it is limited to about 12 000 characters once URL-encoded. Longer code throws before anything is sent; put it in an Apex class instead.

**How the trace flag is handled**

- A `DebugLevel` named `sobjectly` is created or reused.
- Salesforce allows one trace flag per user. An existing flag is patched and restored afterwards; otherwise a temporary flag is created and deleted.
- The traced user is the authenticated one by default; pass `userId` to trace someone else.
- Captures for the same user through one client run one after another, so they don't fight over the flag.
- If the flag was deleted meanwhile, cleanup skips it. If cleanup fails for another reason, the work's result is still returned, with the error in `cleanupError`. The flag then lapses after `expirationMinutes` (default 30).

**Collecting the logs**

- Only logs created during the work are returned, oldest first.
- If the work throws, you get a `DebugLogCaptureError` that still carries the logs.
- Async Apex the work enqueues (queueable, batch, future methods) usually runs after the capture ends, so its logs are not included.
- At most the 200 newest logs of the user are collected.
- `sf.tooling.debugLogs.list()` and `.body(id)` read existing logs.
