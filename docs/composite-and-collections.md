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

- The builder methods are `create`, `update`, `upsert`, `delete`, `get`, `query` and `request`. `request` covers any other subrequest.
- `ref("id")` produces `@{referenceId.id}`. Deeper paths also work: `ref("records[0].Id")`.
- `result.get(ref)` throws a `SalesforceError` if that subrequest failed. `result.response(ref)` returns the raw status, headers and body.
- `throwOnError: true` throws for the first real failure, skipping the `PROCESSING_HALTED` follow-up errors.
- Reference ids default to `ref1`, `ref2`, and so on. Pass `{ referenceId: "newAccount" }` to name one.

## Composite graph (`/composite/graph`)

Graph requests run several independent groups of subrequests. Each graph succeeds or fails as a whole.

```ts
const graphs = await sf.composite.graph([
	{ graphId: "g1", build: (c) => void c.create("Account", { Name: "One" }) },
	{ graphId: "g2", build: (c) => void c.create("Account", { Name: "Two" }) },
]);
graphs.map((graph) => graph.isSuccessful);
```

## Composite batch (`/composite/batch`)

Batch requests run up to 25 independent subrequests. Each one counts against your API limits.

```ts
const batch = await sf.composite.batch([
	{ method: "GET", path: "/sobjects/Account/001..." },
	{ method: "PATCH", path: "/sobjects/Account/001...", body: { Name: "New name" } },
]);
```

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
