# SOQL builder

`sf.soql("Account")` returns a fluent builder bound to your registry. Field names are checked against the generated types, and each `select*` call narrows the record type the query returns.

```ts
const query = sf
	.soql("Account")
	.select("Id", "Name", "Industry")
	.where("Industry", "=", "Energy")
	.orderBy("Name", "ASC", "NULLS LAST")
	.limit(100);

query.build(); // "SELECT Id, Name, Industry FROM Account WHERE Industry = 'Energy' ORDER BY Name ASC NULLS LAST LIMIT 100"
```

Use the builder outside the client with `soqlFor<SObjectRegistry>()("Account")`.

## Running queries

| Method                                            | Returns                                                        |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `sf.query(builder)`                               | The first page: `{ records, totalSize, done, nextRecordsUrl }` |
| `sf.queryMore(page.nextRecordsUrl)`               | The next page, with the same record type                       |
| `sf.iterate(builder)`                             | An async iterator over every record of every page              |
| `sf.collect(builder)`                             | All records of all pages, as an array                          |
| `sf.sobject("Account").query(q => q.select(...))` | The same as above, without repeating the sObject name          |

Every method also accepts a SOQL string plus a record type: `sf.query<{ Id: string }>("SELECT Id FROM Account")`.

Options:

- `{ includeDeleted: true }` uses `/queryAll`;
- `{ batchSize: 500 }` sends `Sforce-Query-Options`;
- `{ signal }` cancels the request.

Records keep the `attributes` object Salesforce returns (`{ type, url }`).

## Selecting

| Method                                             | SOQL                        | Result type                                                   |
| -------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `select("Id", "Name")`                             | `Id, Name`                  | `Pick<Account, "Id" \| "Name">`                               |
| _(no select)_ + `limit(n ≤ 200)`                   | `FIELDS(ALL)`               | the full `Account`                                            |
| `selectRelated("Owner", "Name", "Email")`          | `Owner.Name, Owner.Email`   | `{ Owner: Pick<User, ...> \| null }`                          |
| `selectRelated("Account.Owner", "Email")`          | `Account.Owner.Email`       | `{ Account: { Owner: Pick<User, "Email"> \| null } \| null }` |
| `selectPolymorphic("Owner", "Name")`               | `Owner.Name`                | Name fields; `attributes.type` is `"Group" \| "User"`         |
| `selectTypeOf("What", t => t.when(...).else(...))` | `TYPEOF What WHEN ... END`  | a union per type (see below)                                  |
| `selectChild("Contacts", c => c.select("Id"))`     | `(SELECT Id FROM Contacts)` | `{ Contacts: { records, totalSize, done } \| null }`          |
| `count()`                                          | `COUNT()`                   | the count is in `totalSize`                                   |
| `count("Id", "total")`, `countDistinct(...)`       | `COUNT(Id) total`           | `{ total: number }`                                           |
| `sum` / `avg` (numeric fields only)                | `SUM(Amount) amount`        | `{ amount: number \| null }`                                  |
| `min` / `max`                                      | `MIN(CreatedDate) first`    | the field's type                                              |
| `selectRaw("CALENDAR_YEAR(CreatedDate) y")`        | as written                  | adds `Record<string, unknown>`                                |

Select calls accumulate, and duplicate fields are dropped.

### Parent paths

`selectRelated`, `whereRelated` and `orderByRelated` accept dotted child-to-parent paths such as `"Account.Owner"`. Each path segment and each field autocompletes, and every level is `| null` in the result.

The types cover up to 3 hops, which keeps compile times low on big registries. Salesforce allows 5, and at runtime paths up to 5 levels are accepted.

### Polymorphic lookups

Lookups with more than one possible target, such as `Owner` on Case or `What` and `Who` on Task, have two helpers. The codegen lists these relationships in `polymorphicParents`.

- **`selectPolymorphic("Owner", "Name", "Type")`** selects the fields every target shares: `Id, Name, Type, Alias, Email, FirstName, LastName, IsActive, Phone, Title, Username`.
- **`selectTypeOf`** picks different fields per target type, with `TYPEOF`. The result is a union:

```ts
import { isSObjectType } from "@cerios/salesforce-sobjectly";

const tasks = await sf.collect(
	sf
		.soql("Task")
		.select("Id")
		.selectTypeOf("What", (t) => t.when("Account", "Phone").when("Opportunity", "Amount").else("Name")),
);
for (const task of tasks) {
	if (isSObjectType(task.What, "Account")) task.What.Phone; // typed as Account fields
}
```

Use `isSObjectType` to narrow the union: TypeScript doesn't narrow on `record.attributes.type === "Account"`, because the property is nested.

TYPEOF is rejected with `groupBy`, in child subqueries, in semi-joins and in Bulk queries, since Salesforce doesn't support it there.

## Filtering

```ts
sf.soql("Case")
	.select("Id")
	.where("Status", "!=", "Closed") // = != > < >= <= LIKE
	.whereIn("Priority", ["High", "Medium"])
	.whereNotIn("AccountId", sf.soql("Account").select("Id").where("Industry", "=", "Energy")) // semi-join
	.whereRelated("Account", "Name", "LIKE", "Acme%")
	.whereGroup((g) => g.where("Origin", "=", "Web").where("Origin", "=", "Email"), "OR")
	.whereRaw("CALENDAR_YEAR(CreatedDate) = 2026");
```

- Top-level conditions are joined with `AND`. Use `whereGroup` for `OR`; groups nest.
- `whereNot((g) => ...)` negates a group: `(NOT (...))`.
- `whereIncludes` / `whereExcludes` are for multi-select picklists. `whereIncludes("Interests__c", [["Golf", "Tennis"], "Chess"])` matches "Golf and Tennis" or "Chess".
- Values are escaped. Strings are quoted, with `'` and `\` escaped.
- `whereRaw` and `havingRaw` fragments are wrapped in parentheses, so an `OR` inside them can't leak into the surrounding `AND`.

### LIKE with user input

In a `LIKE` pattern, `%` and `_` are wildcards. To match user input literally, use `soqlLike`. It escapes the wildcards and adds them for the mode you pick:

```ts
import { soqlLike } from "@cerios/salesforce-sobjectly";

sf.soql("Account").select("Id").where("Name", "LIKE", soqlLike(userInput, "startsWith"));
// Name LIKE 'Acme 50\% off%'
```

The modes are `"contains"` (the default), `"startsWith"`, `"endsWith"` and `"exact"`.

### Values are checked per field

With a generated registry, `where`, `whereIn` and `whereRelated` check the value against the field:

| Field               | Accepted values                                                                |
| ------------------- | ------------------------------------------------------------------------------ |
| Date (`Birthdate`)  | `soqlDate(new Date())`, `soqlDate("2026-01-31")` or `soqlDateLiteral("TODAY")` |
| DateTime            | a `Date`, or `soqlDateLiteral("LAST_N_DAYS", 30)`                              |
| Time                | `soqlLiteral("13:00:00.000Z")`                                                 |
| Number              | a `number`                                                                     |
| Checkbox            | `true` / `false`, only with `=` and `!=`                                       |
| Restricted picklist | only its values (only enum members with `picklists: "enum"`)                   |
| `null`              | `!= null` on any field; `= null` only on nillable fields                       |

`LIKE` only works on text fields.

Date fields don't accept a `Date` or a string. Both would produce invalid SOQL: a DateTime literal on a Date field, or a quoted date.

A `Date` on a DateTime field is sent in UTC, to the second. `soqlDate(date)` uses the UTC date too; pass `soqlDate(date, { local: true })` to use the date in the local time zone.

Only values made by the helpers (`soqlLiteral`, `soqlDate`, `soqlDateLiteral`, `soqlLike`) are inserted unquoted. A plain `{ sql: "..." }` object is rejected, so input that has been through `JSON.parse` can't inject SOQL.

`soqlDateLiteral` covers every SOQL date literal, including `THIS_FISCAL_QUARTER` and `N_DAYS_AGO`, with typed names.

## Grouping, ordering, paging

```ts
sf.soql("Opportunity")
	.select("StageName")
	.sum("Amount", "total")
	.groupBy("StageName")
	.havingRaw("SUM(Amount) > 10000")
	.orderBy("StageName")
	.limit(10)
	.offset(20) // max 2000
	.withUserMode() // enforce the running user's sharing and FLS
	.for("VIEW"); // FOR VIEW / REFERENCE / UPDATE
```

## Reusing a base query

Builders are mutable: every method changes the builder and returns it. To branch off a shared base query, `clone()` it first:

```ts
const base = sf.soql("Account").select("Id", "Name");
const energy = await base.clone().where("Industry", "=", "Energy").all();
const banking = await base.clone().where("Industry", "=", "Banking").all();
```

## Long queries

Salesforce rejects request URLs longer than about 16 KB, which a `whereIn` with roughly 700 ids already reaches. Queries whose URL would be longer than 12 000 characters are sent as a composite subrequest in the request body instead. This is automatic, costs no extra API call, and works up to Salesforce's SOQL limit of 100 000 characters. It applies to `query`, `collect`, `iterate` and the Tooling API.

## Escape hatches and escaping

Use `selectRaw`, `whereRaw`, `havingRaw` and `orderByRaw` for anything the typed methods don't cover, such as functions, or paths deeper than the 3 typed hops. Escape any value you put in them:

```ts
import { soqlEscape, soslEscape } from "@cerios/salesforce-sobjectly";

sf.soql("Account")
	.select("Id")
	.whereRaw(`Owner.Name = ${soqlEscape(userInput)}`);
sf.search.sosl(`FIND {${soslEscape(term)}} IN NAME FIELDS RETURNING Account(Id, Name)`);
```

## Runtime checks

`build()` throws for queries Salesforce would reject:

- an empty `IN ()`;
- a semi-join subquery that selects more than one field;
- `FIELDS(ALL)` without `limit(≤ 200)`, or combined with `groupBy`;
- an invalid aggregate alias;
- `offset` above 2000;
- a blank raw fragment;
- an invalid field name, operator or alias, or an alias that is a SOQL reserved word;
- `count()` combined with other fields, `groupBy` or `orderBy`.
