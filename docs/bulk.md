# Bulk API 2.0

Use Bulk API 2.0 for large volumes: thousands to millions of records. Jobs run asynchronously in Salesforce, and data moves as CSV.

## Ingest (insert, update, upsert, delete, hardDelete)

```ts
const job = await sf.bulk.ingest({
	object: "Account",
	operation: "upsert",
	externalIdFieldName: "External_Id__c",
	records: [
		{ External_Id__c: "A-1", Name: "Acme", Phone: null }, // null clears the field (#N/A)
		{ External_Id__c: "A-2", Name: "Globex", "Parent.External_Id__c": "A-1" }, // lookup by external id
	],
	wait: { pollIntervalMs: 2_000, timeoutMs: 10 * 60_000 },
});

job.info.numberRecordsProcessed;
const failed = await job.failedResults(); // [{ sf__Id, sf__Error, ...columns }]
const succeeded = await job.successfulResults(); // [{ sf__Id, sf__Created, ...columns }]
```

`ingest()` creates the job, uploads the CSV, closes the job, and waits for it unless you pass `wait: false`. If the job ends as `Failed` or `Aborted`, it throws a `SalesforceBulkJobError`. A job can still complete while some rows fail, so always check `failedResults()`.

To control each step yourself:

```ts
const job = await sf.bulk.createIngestJob({ object: "Contact", operation: "insert" });
await job.upload(csvString); // or an array of records
await job.close();
await job.waitForCompletion();
```

### CSV conversion

The union of all record keys becomes the CSV columns. Values are converted as follows:

| Value                                                        | CSV                                               |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `null`                                                       | `#N/A`, which clears the field                    |
| `undefined`                                                  | empty, which leaves the field unchanged           |
| `Date`                                                       | ISO string; a Date field takes its UTC date       |
| the text `"#N/A"`                                            | `" #N/A"`, stored as the text `#N/A` (see below)  |
| array                                                        | values joined by `;` (for multi-select picklists) |
| nested object, e.g. `{ Account: { External_Id__c: "A-1" } }` | column `Account.External_Id__c`                   |

Bulk API reads `#N/A` as null, quoted or not. Salesforce trims surrounding whitespace from text values, through the REST API as well, so the text `#N/A` is written with a leading space and stored exactly as `#N/A`. The same trimming means `"  hello  "` is stored as `hello`.

One upload may be at most 100 MB. Split bigger data sets over several jobs.

## Query

```ts
for await (const row of sf.bulk.query(sf.soql("Contact").select("Id", "Email").selectRelated("Account", "Name"))) {
	row.Id; // string
	row["Account.Name"]; // string: CSV values are always strings
}
```

`bulk.query()` creates a query job, waits for it to finish, and streams the results page by page (following `Sforce-Locator`). Pass `includeDeleted: true` for `queryAll`, and `maxRecords` to set the page size.

Bulk query does not support aggregate functions, `GROUP BY`, `OFFSET`, `TYPEOF`, compound fields or parent-to-child subqueries. Use the regular query API for those.

## Buffering

Transports return complete response bodies, not streams. Every result page is held in memory before it is parsed, so use `maxRecords` to keep pages to a comfortable size.
