# Composite requests and sObject collections

## Composite (`/composite`)

Up to 25 subrequests go in a single API call, and later subrequests can use the results of earlier ones. At most 5 of them can be queries or collection calls.

```ts
const result = await sf.composite.execute(
	(c) => {
		const account = c.create("Account", { Name: "Acme" });
		const contact = c.create("Contact", { LastName: "Doe", AccountId: account.ref("id") });
		const check = c.query(sf.soql("Contact").select("Id", "Email").where("AccountId", "=", account.ref("id")));
		return { account, contact, check };
	},
	{ allOrNone: true },
);

result.get(result.refs.account).id; // string | undefined
result.get(result.refs.check).records; // typed as { Id, Email }[]
result.hasErrors;
```

- The typed builder methods are `create`, `update`, `upsert`, `delete`, `get`, `getByExternalId`, `children`, `parent`, `query`, `queryAll`, `describe`, `basicInfo`, `getDeleted` and `getUpdated`. `request` covers any other subrequest.
- sObject Collections run inside the composite as well, so records can reference earlier results: `createMany`, `updateMany`, `upsertMany`, `deleteMany` and `retrieveMany` (up to 200 records each, 2000 ids for `retrieveMany`). Like queries, they count against the limit of 5.
- `ref("id")` produces `@{referenceId.id}`. Deeper paths also work: `ref("records[0].Id")`.
- `result.get(ref)` throws a `SalesforceError` if that subrequest failed. `result.response(ref)` returns the raw status, headers and body.
- `throwOnError: true` throws for the first real failure, skipping the `PROCESSING_HALTED` follow-up errors.
- Reference ids default to `ref1`, `ref2`, and so on. Pass `{ referenceId: "newAccount" }` to name one.

## Composite graph (`/composite/graph`)

Graph requests run several independent groups of subrequests. Each graph succeeds or fails as a whole. A graph's `build` uses the same builder as `execute`; whatever it returns becomes that graph's `response.refs`. Results come back in the order of the input.

```ts
const [one, two] = await sf.composite.graph([
	{ graphId: "g1", build: (c) => ({ account: c.create("Account", { Name: "One" }) }) },
	{ graphId: "g2", build: (c) => void c.create("Account", { Name: "Two" }) },
]);
one.isSuccessful;
one.response.get(one.response.refs.account).id; // string | undefined
```

## Composite batch (`/composite/batch`)

Batch requests run up to 25 independent subrequests. Each one counts against your API limits. They run in order and each commits on its own, so a failure doesn't roll back earlier subrequests. Salesforce stops a batch after 10 minutes, which is longer than the client's default timeout: pass `timeoutMs` (for example `{ timeoutMs: 600_000 }`) for long batches. The builder works like the one of `execute`, with typed paths, bodies and results, but batch subrequests can't reference each other, so the handles have no `ref()`.

```ts
const result = await sf.composite.batch(
	(b) => ({
		account: b.get("Account", accountId, ["Name", "Industry"]),
		contacts: b.children("Account", accountId, "Contacts", ["LastName"]),
		open: b.query(sf.soql("Case").select("Id", "Subject").where("IsClosed", "=", false)),
		hits: b.search("FIND {Acme} RETURNING Account(Id, Name)"),
		limits: b.limits(),
	}),
	{ haltOnError: true },
);

result.get(result.refs.account).Industry; // typed from the registry
result.get(result.refs.open).records; // { Id, Subject }[]
result.result(result.refs.limits).statusCode; // the raw status and result
```

- Besides the shared methods (see `execute` above), the batch builder has `limits()` and `search(sosl)`. `request()` covers the other resources batch supports: Connect (`/connect`), Chatter (`/chatter`) and invocable actions (`/actions`).
- `result.get(ref)` throws a `SalesforceError` when that subrequest failed. With `haltOnError: true`, Salesforce skips the rest after a failure and returns status 412 (`BATCH_PROCESSING_HALTED`) for them. `throwOnError: true` throws for the first real failure, ignoring those skipped ones.
- The array form `sf.composite.batch([{ method, path, body }])` still works. It is untyped and returns the raw `{ hasErrors, results }`.

### Files in a batch

A batch can upload files as binary parts. The batch is then sent as `multipart/form-data`.

```ts
await sf.composite.batch((b) => ({
	version: b.createWithBlob(
		"ContentVersion",
		{ Title: "Invoice", PathOnClient: "invoice.pdf" },
		{ field: "VersionData", fileName: "invoice.pdf", contentType: "application/pdf", data: bytes },
	),
	file: b.request({
		method: "POST",
		path: "/connect/files/users/me",
		body: { title: "Notes" },
		binary: { alias: "fileData", fileName: "notes.txt", data: "hello" },
	}),
}));
```

`updateWithBlob` replaces a blob field of an existing record. The `field` is the blob field, which Salesforce uses as the part name (`binaryPartNameAlias`): `VersionData` for ContentVersion, `Body` for Attachment and Document. For files larger than a few megabytes, prefer `sf.files.upload()`.

## sObject tree (`/composite/tree`)

A tree request creates records with nested children, up to 200 records in total, in one all-or-nothing call.

```ts
await sf.composite.tree("Account", [
	{
		attributes: { type: "Account", referenceId: "acme" },
		Name: "Acme",
		Contacts: { records: [{ attributes: { type: "Contact", referenceId: "doe" }, LastName: "Doe" }] },
	},
]);
```

## sObject collections (`/composite/sobjects`)

Collections work on up to 200 records per call. With `{ chunk: true }`, larger arrays are split into sequential calls. Those calls are separate transactions, so `chunk` cannot be combined with `allOrNone`.

```ts
await sf.collections.create("Account", [{ Name: "A" }, { Name: "B" }], { allOrNone: true });
await sf.collections.update("Account", [{ Id: id1, Phone: "1" }]);
await sf.collections.upsert("Account", "External_Id__c", [{ Name: "A", External_Id__c: "A-1" }]);
await sf.collections.delete([id1, id2]);
const records = await sf.collections.retrieve("Account", [id1, id2], ["Id", "Name"]); // null for missing ids
```

When any record fails, these calls throw a `SalesforceSaveError` whose `results` holds every item's result. Pass `throwOnError: false` to inspect the results yourself.
