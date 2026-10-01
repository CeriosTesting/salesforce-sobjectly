import type {
	ChildRelationshipName,
	ChildSObjectName,
	GenericRegistry,
	MultiPicklistField,
	ParentPath,
	PolymorphicRelationshipName,
	PolymorphicTargets,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
} from "../registry";
import type { WithAttributes } from "../types/common";

import { soqlEscape, type SoqlValue } from "./escape";
import type {
	NestPath,
	PathTarget,
	PolymorphicName,
	PolymorphicNameField,
	SoqlFieldValue,
	SoqlOperatorFor,
	SoqlWhereValue,
	TypedRecord,
	TypeOfField,
	TypeOfPick,
} from "./types";

export type { SoqlComparisonOperator, SoqlOperator } from "./types";
export type SoqlDirection = "ASC" | "DESC";
export type SoqlNullOrder = "NULLS FIRST" | "NULLS LAST";

declare const noSelectionBrand: unique symbol;
/** Marker for "nothing selected yet", which queries `FIELDS(ALL)` and returns the full record. */
export type NoSelection = { readonly [noSelectionBrand]: true };

type SelectedRecord<R, K extends SObjectName<R>, S extends object> = S extends NoSelection ? SObjectRecord<R, K> : S;
type ExplicitSelection<S extends object> = S extends NoSelection ? object : S;

type NumericField<R, K extends SObjectName<R>> = string extends keyof SObjectRecord<R, K>
	? string
	: {
			[P in SObjectFieldName<R, K>]: Exclude<SObjectRecord<R, K>[P], null | undefined> extends number ? P : never;
		}[SObjectFieldName<R, K>];

/** The value of a parent-to-child subquery field. Salesforce returns `null` when there are no child rows. */
export type SoqlChildQueryResult<TRecord> = {
	records: WithAttributes<TRecord>[];
	totalSize: number;
	done: boolean;
	nextRecordsUrl?: string;
};

/** The record type a query built with `SoqlQueryBuilder<R, K, S>` returns. */
export type SoqlQueryRecord<R, K extends SObjectName<R>, S extends object> = WithAttributes<SelectedRecord<R, K, S>>;

/** Salesforce requires `LIMIT` of at most 200 when `FIELDS(ALL)` is used. */
const FIELDS_ALL_MAX_LIMIT = 200;
const MAX_OFFSET = 2_000;
/** Salesforce allows at most 5 levels in a child-to-parent path. */
const MAX_PARENT_DEPTH = 5;
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A field name; dotted paths are allowed for untyped registries (e.g. `"Account.Name"`). */
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
const OPERATORS = new Set(["=", "!=", ">", "<", ">=", "<=", "LIKE"]);
const DIRECTIONS = new Set(["ASC", "DESC"]);
const NULL_ORDERS = new Set(["NULLS FIRST", "NULLS LAST"]);
/** SOQL keywords that can't be used as aggregate aliases. */
const RESERVED_WORDS = new Set(
	[
		"AND",
		"ASC",
		"AT",
		"BY",
		"CUBE",
		"DESC",
		"ELSE",
		"END",
		"EXCLUDES",
		"FALSE",
		"FIRST",
		"FOR",
		"FORMAT",
		"FROM",
		"GROUP",
		"HAVING",
		"IN",
		"INCLUDES",
		"LAST",
		"LIKE",
		"LIMIT",
		"NOT",
		"NULL",
		"NULLS",
		"OFFSET",
		"OR",
		"ORDER",
		"REFERENCE",
		"ROLLUP",
		"SELECT",
		"THEN",
		"TRACKING",
		"TRUE",
		"TYPEOF",
		"UPDATE",
		"USING",
		"VIEW",
		"WHEN",
		"WHERE",
		"WITH",
	].map((word) => word.toLowerCase()),
);

/**
 * Builds a `TYPEOF` expression for a polymorphic relationship. Each `when` narrows the result to a
 * record whose `attributes.type` is that sObject; `else` covers the remaining types with Name fields.
 */
export class TypeOfBuilder<R extends object, Remaining extends string, Result = never> {
	private readonly _whens: string[] = [];
	private readonly _types = new Set<string>();
	private _else: string | undefined;

	/** `WHEN type THEN fields`. */
	when<T extends Remaining, F extends TypeOfField<R, T>>(
		sobject: T,
		firstField: F,
		...additionalFields: F[]
	): TypeOfBuilder<R, Exclude<Remaining, T>, Result | TypedRecord<T, TypeOfPick<R, T, F>>> {
		assertIdentifier("TYPEOF when()", sobject);
		if (this._types.has(sobject)) {
			throw new Error(`TYPEOF already has a WHEN ${sobject} clause.`);
		}
		if (this._else !== undefined) {
			throw new Error("TYPEOF when() must come before else().");
		}
		this._types.add(sobject);
		this._whens.push(`WHEN ${sobject} THEN ${fieldList([firstField, ...additionalFields])}`);
		return this;
	}

	/** `ELSE fields`: the Name fields for every type without a `when`. */
	else<F extends PolymorphicNameField>(
		firstField: F,
		...additionalFields: F[]
	): TypeOfBuilder<R, never, Result | TypedRecord<Remaining, Pick<PolymorphicName, F>>> {
		this._else = fieldList([firstField, ...additionalFields]);
		return this;
	}

	/** @internal */
	toSoql(relationship: string): string {
		if (this._whens.length === 0) {
			throw new Error(`selectTypeOf("${relationship}") requires at least one when().`);
		}
		const elseClause = this._else === undefined ? "" : ` ELSE ${this._else}`;
		return `TYPEOF ${relationship} ${this._whens.join(" ")}${elseClause} END`;
	}
}

/**
 * Narrows a record by its `attributes.type`, e.g. the union returned for a `selectTypeOf` field.
 * TypeScript doesn't narrow on nested properties, so `record.attributes.type === "Account"` alone
 * won't narrow; this guard does:
 *
 * ```ts
 * if (isSObjectType(task.What, "Account")) task.What.Phone;
 * ```
 */
export function isSObjectType<U extends { attributes: { type: string } }, T extends U["attributes"]["type"]>(
	record: U | null | undefined,
	type: T,
): record is Extract<U, { attributes: { type: T } }> {
	return record?.attributes.type === type;
}

type TypeOfResult<Remaining extends string, Result> =
	| Result
	| ([Remaining] extends [never] ? never : TypedRecord<Remaining, object>);

/**
 * A type-safe, fluent SOQL builder. Field names are checked against the registry, values are
 * checked per field type, and the selected fields narrow the record type the query returns.
 *
 * Create one with `client.soql("Account")` or `soqlFor<SObjectRegistry>()("Account")`.
 *
 * - `select` for direct fields;
 * - `selectRelated("Account.Owner", ...)` for child-to-parent paths (up to 3 hops typed);
 * - `selectChild` for parent-to-child subqueries;
 * - `selectPolymorphic` / `selectTypeOf` for polymorphic lookups such as `Owner` or `What`;
 * - `selectRaw` / `whereRaw` for anything else (escape values with `soqlEscape`).
 *
 * Builders are **mutable**: every method changes the builder and returns it. To branch off a
 * shared base query, `clone()` it first:
 *
 * ```ts
 * const base = sf.soql("Account").select("Id");
 * const energy = base.clone().where("Industry", "=", "Energy");
 * const banking = base.clone().where("Industry", "=", "Banking");
 * ```
 */
export class SoqlQueryBuilder<R extends object, K extends SObjectName<R>, S extends object = NoSelection> {
	private readonly _fromClause: string;
	private _fields: string[] = [];
	private _conditions: string[] = [];
	private _groupBy: string[] = [];
	private _having: string[] = [];
	private _orderBy: string[] = [];
	private _limit: number | undefined;
	private _offset: number | undefined;
	private _withUserMode = false;
	private _forClause: string | undefined;
	private _usesTypeOf = false;
	private _countAll = false;
	private _usesAggregates = false;

	private constructor(fromClause: string) {
		this._fromClause = fromClause;
	}

	/** Returns an independent copy, so the original can be reused as a base for other queries. */
	clone(): SoqlQueryBuilder<R, K, S> {
		const copy = new SoqlQueryBuilder<R, K, S>(this._fromClause);
		copy._fields = [...this._fields];
		copy._conditions = [...this._conditions];
		copy._groupBy = [...this._groupBy];
		copy._having = [...this._having];
		copy._orderBy = [...this._orderBy];
		copy._limit = this._limit;
		copy._offset = this._offset;
		copy._withUserMode = this._withUserMode;
		copy._forClause = this._forClause;
		copy._usesTypeOf = this._usesTypeOf;
		copy._countAll = this._countAll;
		copy._usesAggregates = this._usesAggregates;
		return copy;
	}

	/** Starts a query on `sobjectName`. Prefer `client.soql()` or `soqlFor<R>()`, which infer `R`. */
	static from<R extends object, K extends SObjectName<R>>(sobjectName: K): SoqlQueryBuilder<R, K> {
		if (typeof sobjectName !== "string" || !IDENTIFIER.test(sobjectName)) {
			throw new Error(`Invalid sObject name "${String(sobjectName)}".`);
		}
		return new SoqlQueryBuilder<R, K>(sobjectName);
	}

	/** The sObject (or child relationship, in a subquery) this query selects from. */
	get sobjectName(): string {
		return this._fromClause;
	}

	/** `true` when the query contains `TYPEOF`, which Bulk API, semi-joins and GROUP BY don't support. */
	get usesTypeOf(): boolean {
		return this._usesTypeOf;
	}

	/** Adds fields to the select list. The result type is narrowed to the selected fields. */
	select<F extends SObjectFieldName<R, K>>(
		firstField: F,
		...additionalFields: F[]
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Pick<SObjectRecord<R, K>, F>> {
		if (typeof firstField !== "string" || firstField.length === 0) {
			throw new Error("select() requires at least one field.");
		}
		const fields = [firstField, ...additionalFields];
		fields.forEach((field) => assertField("select()", field));
		this.addFields(fields);
		return this.cast();
	}

	/** Escape hatch for select expressions the typed helpers can't express. The result gains an index signature. */
	selectRaw(
		firstExpression: string,
		...additionalExpressions: string[]
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<string, unknown>> {
		const expressions = [firstExpression, ...additionalExpressions];
		expressions.forEach((expression) => assertNonBlank("selectRaw", expression));
		this.addFields(expressions);
		return this.cast();
	}

	/**
	 * Selects fields through a child-to-parent path, e.g. `selectRelated("Account", "Name")` or
	 * `selectRelated("Account.Owner", "Email")` from `Contact`. Each level is `| null` in the result.
	 */
	selectRelated<P extends ParentPath<R, K>, F extends SObjectFieldName<R, PathTarget<R, K, P>>>(
		path: P,
		firstField: F,
		...additionalFields: F[]
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & NestPath<P, Pick<SObjectRecord<R, PathTarget<R, K, P>>, F>>> {
		assertParentPath(path);
		const fields = [firstField, ...additionalFields];
		fields.forEach((field) => assertIdentifier("selectRelated()", field));
		this.addFields(fields.map((field) => `${String(path)}.${field}`));
		return this.cast();
	}

	/**
	 * Selects Name fields of a polymorphic lookup without TYPEOF, e.g. `selectPolymorphic("Owner", "Name")`
	 * from `Case`. `attributes.type` tells which sObject it is.
	 */
	selectPolymorphic<Rel extends PolymorphicRelationshipName<R, K>, F extends PolymorphicNameField>(
		relationship: Rel,
		firstField: F,
		...additionalFields: F[]
	): SoqlQueryBuilder<
		R,
		K,
		ExplicitSelection<S> & {
			[P in Rel]: TypedRecord<PolymorphicTargets<R, K, Rel>, Pick<PolymorphicName, F>> | null;
		}
	> {
		assertIdentifier("selectPolymorphic()", relationship);
		[firstField, ...additionalFields].forEach((field) => assertIdentifier("selectPolymorphic()", field));
		this.addFields([firstField, ...additionalFields].map((field) => `${String(relationship)}.${field}`));
		return this.cast();
	}

	/**
	 * Adds a `TYPEOF` expression for a polymorphic lookup. The result is a union discriminated on
	 * `attributes.type`:
	 *
	 * ```ts
	 * sf.soql("Task").select("Id").selectTypeOf("What", (t) =>
	 * 	t.when("Account", "Phone").when("Opportunity", "Amount").else("Name"),
	 * );
	 * ```
	 */
	selectTypeOf<Rel extends PolymorphicRelationshipName<R, K>, Remaining extends string, Result>(
		relationship: Rel,
		build: (typeOf: TypeOfBuilder<R, PolymorphicTargets<R, K, Rel>>) => TypeOfBuilder<R, Remaining, Result>,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & { [P in Rel]: TypeOfResult<Remaining, Result> | null }> {
		assertIdentifier("selectTypeOf()", relationship);
		const builder = build(new TypeOfBuilder<R, PolymorphicTargets<R, K, Rel>>());
		this._fields.push(builder.toSoql(relationship));
		this._usesTypeOf = true;
		return this.cast();
	}

	/**
	 * Adds a parent-to-child subquery, e.g. `selectChild("Contacts", c => c.select("Id", "Email"))`
	 * from `Account` builds `(SELECT Id, Email FROM Contacts)`.
	 */
	selectChild<
		Rel extends ChildRelationshipName<R, K>,
		ChildSelection extends object,
		ChildName extends ChildSObjectName<R, K, Rel> = ChildSObjectName<R, K, Rel>,
	>(
		relationship: Rel,
		build: (sub: SoqlQueryBuilder<R, ChildName>) => SoqlQueryBuilder<R, ChildName, ChildSelection>,
	): SoqlQueryBuilder<
		R,
		K,
		ExplicitSelection<S> & {
			[P in Rel]: SoqlChildQueryResult<SelectedRecord<R, ChildName, ChildSelection>> | null;
		}
	> {
		assertIdentifier("selectChild()", relationship);
		const sub = new SoqlQueryBuilder<R, ChildName>(relationship);
		const result = build(sub);
		if ((result as unknown) !== sub) {
			throw new Error(`selectChild("${String(relationship)}") callback must return the provided query builder.`);
		}
		if (sub._fields.length === 0) {
			throw new Error(`selectChild("${String(relationship)}") requires select() with at least one field.`);
		}
		const invalid = [
			sub._usesTypeOf ? "TYPEOF" : "",
			sub._usesAggregates || sub._countAll ? "aggregate functions" : "",
			sub._groupBy.length > 0 || sub._having.length > 0 ? "GROUP BY/HAVING" : "",
			sub._withUserMode ? "WITH USER_MODE" : "",
			sub._forClause ? `FOR ${sub._forClause}` : "",
		].filter((item) => item.length > 0);
		if (invalid.length > 0) {
			throw new Error(`selectChild("${String(relationship)}"): ${invalid.join(", ")} can't be used in a subquery.`);
		}
		this._fields.push(`(${sub.build()})`);
		return this.cast();
	}

	/** `SELECT COUNT() FROM ...`: the count is in the result's `totalSize`; `records` is empty. */
	count(): SoqlQueryBuilder<R, K, ExplicitSelection<S>>;
	/** `COUNT(field) alias`. */
	count<F extends SObjectFieldName<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, number>>;
	count(field?: string, alias?: string): SoqlQueryBuilder<R, K, object> {
		if (field === undefined) {
			this._countAll = true;
			this.addFields(["COUNT()"]);
		} else {
			this.selectAggregate("COUNT", field, alias);
		}
		return this.cast();
	}

	countDistinct<F extends SObjectFieldName<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, number>> {
		this.selectAggregate("COUNT_DISTINCT", field, alias);
		return this.cast();
	}

	sum<F extends NumericField<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, number | null>> {
		this.selectAggregate("SUM", field, alias);
		return this.cast();
	}

	avg<F extends NumericField<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, number | null>> {
		this.selectAggregate("AVG", field, alias);
		return this.cast();
	}

	min<F extends SObjectFieldName<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, SObjectRecord<R, K>[F] | null>> {
		this.selectAggregate("MIN", field, alias);
		return this.cast();
	}

	max<F extends SObjectFieldName<R, K>, A extends string>(
		field: F,
		alias: A,
	): SoqlQueryBuilder<R, K, ExplicitSelection<S> & Record<A, SObjectRecord<R, K>[F] | null>> {
		this.selectAggregate("MAX", field, alias);
		return this.cast();
	}

	/**
	 * Adds `field operator value`. The value is escaped and type-checked against the field:
	 * date fields take `soqlDate()`/`soqlDateLiteral()`, datetime fields a `Date` or literal,
	 * `LIKE` only works on text, and `null` only on nillable fields with `=`/`!=`.
	 */
	where<F extends SObjectFieldName<R, K>, O extends SoqlOperatorFor<R, K, F>>(
		field: F,
		operator: O,
		value: SoqlWhereValue<R, K, F, O>,
	): this {
		assertField("where()", field);
		assertOperator(operator);
		this._conditions.push(`${field} ${operator} ${soqlEscape(value)}`);
		return this;
	}

	/**
	 * Adds a raw condition, wrapped in parentheses so an `OR` inside it can't change how it combines
	 * with other conditions. Escape interpolated values with `soqlEscape`.
	 */
	whereRaw(conditionSql: string): this {
		assertNonBlank("whereRaw", conditionSql);
		this._conditions.push(`(${conditionSql})`);
		return this;
	}

	/** `field IN (...)` with a list of values or a single-field semi-join subquery. */
	whereIn<F extends SObjectFieldName<R, K>, SK extends SObjectName<R>, SubSelection extends object>(
		field: F,
		values: readonly SoqlFieldValue<R, K, F>[] | SoqlQueryBuilder<R, SK, SubSelection>,
	): this {
		return this.whereSet(field, "IN", values);
	}

	/** `field NOT IN (...)` with a list of values or a single-field anti-join subquery. */
	whereNotIn<F extends SObjectFieldName<R, K>, SK extends SObjectName<R>, SubSelection extends object>(
		field: F,
		values: readonly SoqlFieldValue<R, K, F>[] | SoqlQueryBuilder<R, SK, SubSelection>,
	): this {
		return this.whereSet(field, "NOT IN", values);
	}

	/**
	 * `field INCLUDES (...)` for multi-select picklists. Each item matches when all its values are
	 * selected: `whereIncludes("Interests__c", [["Golf", "Tennis"], "Chess"])` builds
	 * `INCLUDES ('Golf;Tennis', 'Chess')`.
	 */
	whereIncludes(field: MultiPicklistField<R, K>, values: readonly (string | readonly string[])[]): this {
		return this.whereMultiPicklist(String(field), "INCLUDES", values);
	}

	/** `field EXCLUDES (...)` for multi-select picklists; items combine like `whereIncludes`. */
	whereExcludes(field: MultiPicklistField<R, K>, values: readonly (string | readonly string[])[]): this {
		return this.whereMultiPicklist(String(field), "EXCLUDES", values);
	}

	/**
	 * Wraps conditions in parentheses, joined by `join` (default `OR`). Groups nest, so
	 * `(A OR B) AND (C OR (D AND E))` is expressible. Top-level conditions are always joined with AND.
	 */
	whereGroup(build: (group: SoqlQueryBuilder<R, K>) => void, join: "AND" | "OR" = "OR"): this {
		const conditions = this.groupConditions(build);
		if (conditions.length > 0) {
			this._conditions.push(`(${conditions.join(` ${join} `)})`);
		}
		return this;
	}

	/** Negates a group of conditions: `whereNot(g => g.where("Type", "=", "Prospect"))` builds `(NOT (Type = 'Prospect'))`. */
	whereNot(build: (group: SoqlQueryBuilder<R, K>) => void, join: "AND" | "OR" = "AND"): this {
		const conditions = this.groupConditions(build);
		if (conditions.length === 0) {
			throw new Error("whereNot() requires at least one condition.");
		}
		this._conditions.push(`(NOT (${conditions.join(` ${join} `)}))`);
		return this;
	}

	/**
	 * Condition on a parent field, e.g. `whereRelated("Account", "Name", "=", "Acme")` or
	 * `whereRelated("Account.Owner", "IsActive", "=", true)` from `Contact`.
	 */
	whereRelated<
		P extends ParentPath<R, K>,
		F extends SObjectFieldName<R, PathTarget<R, K, P>>,
		O extends SoqlOperatorFor<R, PathTarget<R, K, P>, F>,
	>(path: P, field: F, operator: O, value: SoqlWhereValue<R, PathTarget<R, K, P>, F, O>): this {
		assertParentPath(path);
		assertIdentifier("whereRelated()", field);
		assertOperator(operator);
		this._conditions.push(`${String(path)}.${field} ${operator} ${soqlEscape(value)}`);
		return this;
	}

	groupBy(...fields: SObjectFieldName<R, K>[]): this {
		fields.forEach((field) => assertField("groupBy()", field));
		this._groupBy.push(...fields);
		return this;
	}

	/** Raw `HAVING` condition, e.g. `"COUNT(Id) > 1"`, wrapped in parentheses. */
	havingRaw(conditionSql: string): this {
		assertNonBlank("havingRaw", conditionSql);
		this._having.push(`(${conditionSql})`);
		return this;
	}

	havingGroup(build: (group: SoqlQueryBuilder<R, K>) => void, join: "AND" | "OR" = "OR"): this {
		const group = new SoqlQueryBuilder<R, K>(this._fromClause);
		build(group);
		group.assertOnly("havingGroup()", "having");
		if (group._having.length > 0) {
			this._having.push(`(${group._having.join(` ${join} `)})`);
		}
		return this;
	}

	orderBy(field: SObjectFieldName<R, K>, direction: SoqlDirection = "ASC", nullOrder?: SoqlNullOrder): this {
		assertField("orderBy()", field);
		this._orderBy.push(`${field} ${orderSuffix(direction, nullOrder)}`);
		return this;
	}

	/** Orders by a parent field, e.g. `orderByRelated("Account", "Name", "DESC")`. */
	orderByRelated<P extends ParentPath<R, K>>(
		path: P,
		field: SObjectFieldName<R, PathTarget<R, K, P>>,
		direction: SoqlDirection = "ASC",
		nullOrder?: SoqlNullOrder,
	): this {
		assertParentPath(path);
		assertIdentifier("orderByRelated()", field);
		this._orderBy.push(`${String(path)}.${field} ${orderSuffix(direction, nullOrder)}`);
		return this;
	}

	/** Raw `ORDER BY` item, e.g. `"Account.Name DESC"`. */
	orderByRaw(expression: string): this {
		assertNonBlank("orderByRaw", expression);
		this._orderBy.push(expression);
		return this;
	}

	/** Adds `WITH USER_MODE`, so sharing rules and field-level security of the running user apply. */
	withUserMode(): this {
		this._withUserMode = true;
		return this;
	}

	limit(count: number): this {
		assertNonNegativeInteger("limit", count);
		this._limit = count;
		return this;
	}

	offset(count: number): this {
		assertNonNegativeInteger("offset", count);
		if (count > MAX_OFFSET) {
			throw new Error(`offset() cannot exceed Salesforce's maximum of ${MAX_OFFSET}.`);
		}
		this._offset = count;
		return this;
	}

	/** Adds `FOR VIEW`, `FOR REFERENCE` or `FOR UPDATE`. */
	for(clause: "VIEW" | "REFERENCE" | "UPDATE"): this {
		this._forClause = clause;
		return this;
	}

	/** Returns the SOQL string. Throws when the query is invalid. */
	build(): string {
		this.assertValidQuery();
		const fields = this._fields.length > 0 ? this._fields.join(", ") : "FIELDS(ALL)";
		const clauses = [`SELECT ${fields} FROM ${this._fromClause}`];
		if (this._conditions.length > 0) {
			clauses.push(`WHERE ${this._conditions.join(" AND ")}`);
		}
		if (this._withUserMode) {
			clauses.push("WITH USER_MODE");
		}
		if (this._groupBy.length > 0) {
			clauses.push(`GROUP BY ${this._groupBy.join(", ")}`);
		}
		if (this._having.length > 0) {
			clauses.push(`HAVING ${this._having.join(" AND ")}`);
		}
		if (this._orderBy.length > 0) {
			clauses.push(`ORDER BY ${this._orderBy.join(", ")}`);
		}
		if (this._limit !== undefined) {
			clauses.push(`LIMIT ${this._limit}`);
		}
		if (this._offset !== undefined) {
			clauses.push(`OFFSET ${this._offset}`);
		}
		if (this._forClause) {
			clauses.push(`FOR ${this._forClause}`);
		}
		return clauses.join(" ");
	}

	toString(): string {
		return this.build();
	}

	private cast<T>(): T {
		return this as unknown as T;
	}

	/** Adds fields, skipping duplicates. Field names are case-insensitive in SOQL. */
	private addFields(fields: string[]): void {
		const existing = new Set(this._fields.map((field) => field.toLowerCase()));
		for (const field of fields) {
			if (!existing.has(field.toLowerCase())) {
				existing.add(field.toLowerCase());
				this._fields.push(field);
			}
		}
	}

	private groupConditions(build: (group: SoqlQueryBuilder<R, K>) => void): string[] {
		const group = new SoqlQueryBuilder<R, K>(this._fromClause);
		build(group);
		group.assertOnly("whereGroup()/whereNot()", "conditions");
		return group._conditions;
	}

	/** A group callback may only add conditions (or HAVING conditions); anything else would be lost. */
	private assertOnly(method: string, allowed: "conditions" | "having"): void {
		const used = [
			this._fields.length > 0 ? "select" : "",
			allowed !== "conditions" && this._conditions.length > 0 ? "where" : "",
			allowed !== "having" && this._having.length > 0 ? "having" : "",
			this._groupBy.length > 0 ? "groupBy" : "",
			this._orderBy.length > 0 ? "orderBy" : "",
			this._limit !== undefined || this._offset !== undefined ? "limit/offset" : "",
			this._withUserMode || this._forClause ? "withUserMode/for" : "",
		].filter((item) => item.length > 0);
		if (used.length > 0) {
			throw new Error(
				`${method} callbacks can only add ${allowed === "conditions" ? "where" : "having"} conditions, not ${used.join(", ")}.`,
			);
		}
	}

	private whereSet<SK extends SObjectName<R>, SubSelection extends object>(
		field: string,
		operator: "IN" | "NOT IN",
		values: readonly unknown[] | SoqlQueryBuilder<R, SK, SubSelection>,
	): this {
		const method = operator === "IN" ? "whereIn" : "whereNotIn";
		assertField(`${method}()`, field);
		if (values instanceof SoqlQueryBuilder) {
			if (values._fields.length !== 1) {
				throw new Error(
					`${method}("${field}", subquery) requires the subquery to select exactly one field, got ${values._fields.length}.`,
				);
			}
			if (values._usesTypeOf) {
				throw new Error(`${method}("${field}", subquery): TYPEOF is not allowed in a semi-join.`);
			}
			this._conditions.push(`${field} ${operator} (${values.build()})`);
			return this;
		}
		if (values.length === 0) {
			throw new Error(`${method}("${field}", []) would build an invalid "${operator} ()" SOQL clause.`);
		}
		this._conditions.push(`${field} ${operator} (${values.map((value) => soqlEscape(value as SoqlValue)).join(", ")})`);
		return this;
	}

	private whereMultiPicklist(
		field: string,
		operator: "INCLUDES" | "EXCLUDES",
		values: readonly (string | readonly string[])[],
	): this {
		assertField(operator === "INCLUDES" ? "whereIncludes()" : "whereExcludes()", field);
		if (values.length === 0) {
			throw new Error(`${operator.toLowerCase()}("${field}", []) requires at least one value.`);
		}
		const items = values.map((value) => soqlEscape(typeof value === "string" ? value : value.join(";")));
		this._conditions.push(`${field} ${operator} (${items.join(", ")})`);
		return this;
	}

	private selectAggregate(fn: string, field: string, alias: string | undefined): void {
		assertField(`${fn}()`, field);
		if (alias === undefined || !ALIAS_PATTERN.test(alias)) {
			throw new Error(`Aggregate alias "${String(alias)}" must be a valid SOQL identifier.`);
		}
		if (RESERVED_WORDS.has(alias.toLowerCase())) {
			throw new Error(`Aggregate alias "${alias}" is a reserved SOQL keyword.`);
		}
		this._usesAggregates = true;
		this._fields.push(`${fn}(${field}) ${alias}`);
	}

	private assertValidQuery(): void {
		if (this._usesTypeOf && this._groupBy.length > 0) {
			throw new Error("TYPEOF can't be combined with groupBy().");
		}
		if (this._countAll && (this._fields.length > 1 || this._groupBy.length > 0 || this._orderBy.length > 0)) {
			throw new Error("count() must be the only selected item and can't be combined with groupBy() or orderBy().");
		}
		if (this._fields.length > 0) {
			return;
		}
		if (this._groupBy.length > 0) {
			throw new Error("groupBy() requires select()/selectRaw(): FIELDS(ALL) can't be used in an aggregate query.");
		}
		if (this._limit === undefined || this._limit > FIELDS_ALL_MAX_LIMIT) {
			throw new Error(
				`Queries using FIELDS(ALL) (select() was never called) require limit() of at most ${FIELDS_ALL_MAX_LIMIT}.`,
			);
		}
	}
}

/** Returns a factory for builders bound to registry `R`: `const soql = soqlFor<SObjectRegistry>(); soql("Account")`. */
export function soqlFor<R extends object = GenericRegistry>(): <K extends SObjectName<R>>(
	sobjectName: K,
) => SoqlQueryBuilder<R, K> {
	return <K extends SObjectName<R>>(sobjectName: K): SoqlQueryBuilder<R, K> => SoqlQueryBuilder.from<R, K>(sobjectName);
}

function fieldList(fields: readonly string[]): string {
	fields.forEach((field) => assertIdentifier("TYPEOF field", field));
	return [...new Set(fields)].join(", ");
}

function assertParentPath(path: string): void {
	const segments = typeof path === "string" ? path.split(".") : [];
	if (segments.length === 0 || segments.some((segment) => !IDENTIFIER.test(segment))) {
		throw new Error(`Invalid relationship path "${String(path)}".`);
	}
	if (segments.length > MAX_PARENT_DEPTH) {
		throw new Error(`Relationship path "${path}" exceeds Salesforce's maximum of ${MAX_PARENT_DEPTH} levels.`);
	}
}

function assertField(context: string, field: string): void {
	if (typeof field !== "string" || !FIELD_PATH.test(field)) {
		throw new Error(`${context}: invalid field name "${String(field)}".`);
	}
}

function assertOperator(operator: string): void {
	if (!OPERATORS.has(operator)) {
		throw new Error(`Invalid SOQL operator "${String(operator)}". Use one of: ${[...OPERATORS].join(", ")}.`);
	}
}

function orderSuffix(direction: string, nullOrder: string | undefined): string {
	if (!DIRECTIONS.has(direction)) {
		throw new Error(`Invalid sort direction "${String(direction)}". Use ASC or DESC.`);
	}
	if (nullOrder !== undefined && !NULL_ORDERS.has(nullOrder)) {
		throw new Error(`Invalid null order "${String(nullOrder)}". Use NULLS FIRST or NULLS LAST.`);
	}
	return `${direction}${nullOrder ? ` ${nullOrder}` : ""}`;
}

function assertIdentifier(context: string, value: string): void {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		throw new Error(`${context}: invalid name "${String(value)}".`);
	}
}

function assertNonBlank(method: string, value: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${method}() requires a non-blank SOQL fragment.`);
	}
}

function assertNonNegativeInteger(method: string, count: number): void {
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`${method}() requires a non-negative safe integer.`);
	}
}
