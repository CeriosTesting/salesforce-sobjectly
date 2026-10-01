import type {
	FieldKind,
	ParentPathTarget,
	PolymorphicTargets,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
} from "../registry";
import type { WithAttributes } from "../types/common";

import type { SoqlLiteral } from "./escape";

export type SoqlComparisonOperator = "=" | "!=" | ">" | "<" | ">=" | "<=";
export type SoqlOperator = SoqlComparisonOperator | "LIKE";

/** Any non-null value the builder can render. */
export type SoqlScalar = string | number | boolean | Date | SoqlLiteral;

type NonNull<T> = Exclude<T, null | undefined>;

/** The TypeScript type of field `F` on `K` (`unknown` for untyped registries). */
type FieldType<R, K extends SObjectName<R>, F extends string> = F extends keyof SObjectRecord<R, K>
	? SObjectRecord<R, K>[F]
	: unknown;

type IsUnknown<T> = unknown extends T ? true : false;

/**
 * The non-null values `where` accepts for field `F`:
 * - date fields: `soqlDate(date)` or a date literal (a quoted string or `Date` would be invalid SOQL);
 * - datetime fields: a `Date` or a literal;
 * - time fields: a literal;
 * - number fields: a number; boolean fields: a boolean;
 * - string and picklist fields: their value type (picklist unions stay checked).
 */
export type SoqlFieldValue<R, K extends SObjectName<R>, F extends string> =
	FieldKind<R, K, F> extends "date"
		? SoqlLiteral
		: FieldKind<R, K, F> extends "datetime"
			? Date | SoqlLiteral
			: FieldKind<R, K, F> extends "time"
				? SoqlLiteral
				: IsUnknown<FieldType<R, K, F>> extends true
					? SoqlScalar
					: NonNull<FieldType<R, K, F>> extends number
						? number | SoqlLiteral
						: NonNull<FieldType<R, K, F>> extends boolean
							? boolean
							: NonNull<FieldType<R, K, F>> extends string
								? NonNull<FieldType<R, K, F>> | SoqlLiteral
								: SoqlScalar;

/** The operators that make sense for field `F` (`LIKE` only on text, `=`/`!=` only on booleans). */
export type SoqlOperatorFor<R, K extends SObjectName<R>, F extends string> =
	FieldKind<R, K, F> extends "multipicklist"
		? "=" | "!="
		: FieldKind<R, K, F> extends "date" | "datetime" | "time"
			? SoqlComparisonOperator
			: IsUnknown<FieldType<R, K, F>> extends true
				? SoqlOperator
				: NonNull<FieldType<R, K, F>> extends boolean
					? "=" | "!="
					: NonNull<FieldType<R, K, F>> extends number
						? SoqlComparisonOperator
						: SoqlOperator;

/**
 * The value `where(field, operator, value)` accepts. `null` works with `!=` on any field
 * (`Id != null`) and with `=` only on nillable fields.
 */
export type SoqlWhereValue<R, K extends SObjectName<R>, F extends string, O extends string> =
	| SoqlFieldValue<R, K, F>
	| (O extends "!=" ? null : O extends "=" ? (null extends FieldType<R, K, F> ? null : never) : never);

/** The sObject at the end of a parent path, e.g. `"User"` for `"Account.Owner"` from `Contact`. */
export type PathTarget<R, K extends SObjectName<R>, P extends string> = ParentPathTarget<R, K, P> & SObjectName<R>;

/** Nests a selection under a dotted parent path: `"Account.Owner"` -> `{ Account: { Owner: V } }`. */
export type NestPath<P extends string, V> = P extends `${infer Head}.${infer Tail}`
	? { [Key in Head]: WithAttributes<NestPath<Tail, V>> | null }
	: { [Key in P]: WithAttributes<V> | null };

/**
 * Fields available on a polymorphic relationship without TYPEOF (the "Name" object), e.g.
 * `Owner.Name` or `What.Type`.
 */
export interface PolymorphicName {
	Id: string;
	Name: string | null;
	Type: string;
	Alias: string | null;
	Email: string | null;
	FirstName: string | null;
	LastName: string | null;
	IsActive: boolean;
	Phone: string | null;
	Title: string | null;
	Username: string | null;
}

export type PolymorphicNameField = Extract<keyof PolymorphicName, string>;

/** A record whose `attributes.type` is narrowed to `T`, so unions can be discriminated. */
export type TypedRecord<T extends string, V> = V & { attributes: { type: T; url?: string } };

/** Fields selectable for `T` inside TYPEOF: its fields when `T` is in the registry, else the Name fields. */
export type TypeOfField<R, T extends string> = T extends SObjectName<R> ? SObjectFieldName<R, T> : PolymorphicNameField;

export type TypeOfPick<R, T extends string, F extends string> =
	T extends SObjectName<R>
		? Pick<SObjectRecord<R, T>, Extract<F, keyof SObjectRecord<R, T>>>
		: Pick<PolymorphicName, Extract<F, PolymorphicNameField>>;

/** The targets of a polymorphic relationship. */
export type TypeOfTargets<R, K extends SObjectName<R>, Rel extends string> = PolymorphicTargets<R, K, Rel>;
