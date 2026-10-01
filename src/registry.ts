import type { GenericRecord } from "./types/common";

/** Field kinds the TypeScript type alone can't tell apart. */
export type FieldKindName = "date" | "datetime" | "time" | "multipicklist";

/**
 * The shape of one entry in a generated `SObjectRegistry`:
 * - `read`: every field as returned by Salesforce;
 * - `create` / `update`: the fields a client may set;
 * - `parents`: child-to-parent relationship name -> parent sObject name (e.g. `{ Account: "Account" }`);
 * - `children`: parent-to-child relationship name -> child sObject name (e.g. `{ Cases: "Case" }`);
 * - `externalIds` (optional): fields usable for upsert / lookup by external id;
 * - `fieldKinds` (optional): date, datetime, time and multipicklist fields;
 * - `recordTypes` (optional): record type DeveloperNames;
 * - `polymorphicParents` (optional): polymorphic lookups -> possible targets (e.g. `{ Owner: "Group" | "User" }`).
 */
export interface SObjectRegistryEntry {
	read: object;
	create: object;
	update: object;
	parents: object;
	children: object;
	externalIds?: string;
	fieldKinds?: object;
	recordTypes?: string;
	polymorphicParents?: object;
}

/**
 * The registry used when no generated registry is supplied: any sObject name, any field.
 * Run the `sobjectly` codegen to get a typed one.
 */
export interface GenericRegistry {
	[sobjectName: string]: {
		read: GenericRecord;
		create: GenericRecord;
		update: GenericRecord;
		parents: Record<string, string>;
		children: Record<string, string>;
		externalIds: string;
		recordTypes: string;
		polymorphicParents: Record<string, string>;
	};
}

/** Every sObject API name in registry `R`. */
export type SObjectName<R> = keyof R & string;

/** The full record type of sObject `K`. */
export type SObjectRecord<R, K extends SObjectName<R>> = R[K] extends { read: infer T extends object }
	? T
	: GenericRecord;

/** The create input type of sObject `K`. */
export type SObjectCreateInput<R, K extends SObjectName<R>> = R[K] extends { create: infer T extends object }
	? T
	: GenericRecord;

/** The update input type of sObject `K`. */
export type SObjectUpdateInput<R, K extends SObjectName<R>> = R[K] extends { update: infer T extends object }
	? T
	: GenericRecord;

/** Every field name of sObject `K`. */
export type SObjectFieldName<R, K extends SObjectName<R>> = keyof SObjectRecord<R, K> & string;

/** Fields of `K` usable for upsert and lookup by external id (all fields when the registry doesn't say). */
export type ExternalIdField<R, K extends SObjectName<R>> = R[K] extends { externalIds: infer E extends string }
	? E
	: SObjectFieldName<R, K>;

/** The kind of field `F` (`"date"`, `"datetime"`, `"time"`, `"multipicklist"`), or `undefined` for any other field. */
export type FieldKind<R, K extends SObjectName<R>, F extends string> = R[K] extends { fieldKinds: infer M }
	? F extends keyof M
		? M[F]
		: undefined
	: undefined;

/** Fields of `K` that are multi-select picklists (all fields when the registry doesn't say). */
export type MultiPicklistField<R, K extends SObjectName<R>> = R[K] extends { fieldKinds: infer M }
	? { [F in keyof M & string]: M[F] extends "multipicklist" ? F : never }[keyof M & string]
	: SObjectFieldName<R, K>;

/** Record type DeveloperNames of `K` (any string when the registry doesn't say). */
export type RecordTypeName<R, K extends SObjectName<R>> = R[K] extends { recordTypes: infer T extends string }
	? T
	: string;

/** Child-to-parent relationship names of sObject `K` (e.g. `"Account"` on `Contact`). */
export type ParentRelationshipName<R, K extends SObjectName<R>> = R[K] extends { parents: infer P }
	? keyof P & string
	: never;

/** The sObject name a parent relationship points to. */
export type ParentSObjectName<R, K extends SObjectName<R>, Rel extends string> = R[K] extends { parents: infer P }
	? Rel extends keyof P
		? P[Rel] & SObjectName<R>
		: never
	: never;

/** Polymorphic relationship names of sObject `K` (e.g. `"Owner"` on `Case`, `"What"` on `Task`). */
export type PolymorphicRelationshipName<R, K extends SObjectName<R>> = R[K] extends { polymorphicParents: infer P }
	? keyof P & string
	: never;

/** The possible target sObject names of a polymorphic relationship. */
export type PolymorphicTargets<R, K extends SObjectName<R>, Rel extends string> = R[K] extends {
	polymorphicParents: infer P;
}
	? Rel extends keyof P
		? P[Rel] & string
		: never
	: never;

/** Parent-to-child relationship names of sObject `K` (e.g. `"Contacts"` on `Account`). */
export type ChildRelationshipName<R, K extends SObjectName<R>> = R[K] extends { children: infer C }
	? keyof C & string
	: never;

/** The sObject name a child relationship points to. */
export type ChildSObjectName<R, K extends SObjectName<R>, Rel extends string> = R[K] extends { children: infer C }
	? Rel extends keyof C
		? C[Rel] & SObjectName<R>
		: never
	: never;

/** `PreviousDepth[n]` is the depth left after one more hop; depth 1 allows exactly one hop. */
type PreviousDepth = [never, never, 1, 2, 3, 4];

/**
 * Child-to-parent paths from `K`, e.g. `"Account"` or `"Account.Owner"`. `Depth` caps the number
 * of hops (default 3) to keep compile times low on large registries; Salesforce allows 5.
 */
export type ParentPath<R, K extends SObjectName<R>, Depth extends number = 3> = [Depth] extends [never]
	? never
	: {
			[Rel in ParentRelationshipName<R, K>]:
				| Rel
				| `${Rel}.${ParentPath<R, ParentSObjectName<R, K, Rel>, PreviousDepth[Depth]>}`;
		}[ParentRelationshipName<R, K>];

/** The sObject name at the end of a parent path. */
export type ParentPathTarget<R, K extends SObjectName<R>, P extends string> = P extends `${infer H}.${infer T}`
	? ParentPathTarget<R, ParentSObjectName<R, K, H>, T>
	: ParentSObjectName<R, K, P>;
