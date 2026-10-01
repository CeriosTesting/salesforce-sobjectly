import type { CodegenDescribe } from "../../src/codegen/generator";
import type { CodegenField } from "../../src/codegen/type-mapper";

type FieldOptions = Partial<Omit<CodegenField, "name" | "type">> & { picklist?: string[]; restricted?: boolean };

function field(name: string, type: string, options: FieldOptions = {}): CodegenField {
	const { picklist, restricted, ...rest } = options;
	return {
		name,
		label: name.replace(/__c$/, "").replace(/_/g, " "),
		type,
		nillable: true,
		createable: true,
		updateable: true,
		defaultedOnCreate: false,
		referenceTo: [],
		relationshipName: null,
		picklistValues: (picklist ?? []).map((value, index) => ({
			active: true,
			defaultValue: index === 0,
			label: value,
			validFor: null,
			value,
		})),
		restrictedPicklist: restricted ?? false,
		...rest,
	};
}

const system = { nillable: false, createable: false, updateable: false, defaultedOnCreate: true };

function lookup(name: string, targets: string[], relationshipName: string, options: FieldOptions = {}): CodegenField {
	return field(name, "reference", { referenceTo: targets, relationshipName, ...options });
}

/** A small, realistic set of describes covering every mapped field type. */
export const describes: CodegenDescribe[] = [
	{
		name: "Account",
		label: "Account",
		fields: [
			field("Id", "id", system),
			field("Name", "string", { nillable: false }),
			field("Type", "picklist", { picklist: ["Customer", "Partner"] }),
			field("Industry", "picklist", { picklist: ["Banking", "Energy"], restricted: true }),
			field("AnnualRevenue", "currency"),
			field("NumberOfEmployees", "int"),
			field("BillingAddress", "address", { createable: false, updateable: false }),
			field("IsDeleted", "boolean", system),
			lookup("OwnerId", ["User"], "Owner", { nillable: false, defaultedOnCreate: true }),
			lookup("ParentId", ["Account"], "Parent"),
			field("CreatedDate", "datetime", system),
			field("Description", "textarea"),
			field("External_Id__c", "string", { externalId: true }),
			field("Website", "url"),
			field("Phone", "phone"),
			field("Location__c", "location"),
		],
		childRelationships: [
			{ childSObject: "Contact", field: "AccountId", relationshipName: "Contacts" },
			{ childSObject: "Case", field: "AccountId", relationshipName: "Cases" },
			{ childSObject: "Account", field: "ParentId", relationshipName: "ChildAccounts" },
			{ childSObject: "AccountHistory", field: "AccountId", relationshipName: "Histories" },
		],
	},
	{
		name: "Contact",
		label: "Contact",
		fields: [
			field("Id", "id", system),
			field("LastName", "string", { nillable: false }),
			field("FirstName", "string"),
			field("Email", "email"),
			lookup("AccountId", ["Account"], "Account"),
			field("Birthdate", "date"),
			lookup("OwnerId", ["User"], "Owner", { nillable: false, defaultedOnCreate: true }),
			field("Interests__c", "multipicklist", { picklist: ["Golf", "Tennis"] }),
			field("Anything__c", "anyType"),
		],
		childRelationships: [{ childSObject: "Case", field: "ContactId", relationshipName: "Cases" }],
	},
	{
		name: "Case",
		label: "Case",
		fields: [
			field("Id", "id", system),
			field("CaseNumber", "string", { ...system, nillable: false }),
			field("Subject", "string"),
			field("Status", "picklist", {
				picklist: ["New", "Working", "Closed"],
				restricted: true,
				nillable: false,
				defaultedOnCreate: true,
			}),
			field("Priority", "picklist", { picklist: ["High", "Low"], restricted: true }),
			lookup("AccountId", ["Account"], "Account"),
			lookup("ContactId", ["Contact"], "Contact"),
			lookup("OwnerId", ["Group", "User"], "Owner", { nillable: false, defaultedOnCreate: true }),
			field("IsClosed", "boolean", system),
			field("ClosedDate", "datetime", { createable: false, updateable: false }),
			field("Score__c", "double"),
			field("Big__c", "long"),
			field("Rate__c", "percent"),
			field("Window__c", "time"),
			field("Attachment__c", "base64"),
			field("Secret__c", "encryptedstring"),
			field("Channel__c", "combobox", { picklist: ["Web", "Phone"] }),
		],
		childRelationships: [{ childSObject: "Task", field: "WhatId", relationshipName: "Tasks" }],
		recordTypeInfos: [{ developerName: "Complaint" }, { developerName: "Master" }, { developerName: "Question" }],
	},
	{
		name: "Order_Shipped__e",
		label: "Order Shipped",
		fields: [
			field("ReplayId", "string", system),
			field("EventUuid", "string", system),
			field("Order_Number__c", "string", { nillable: false }),
			field("Shipped_At__c", "datetime"),
		],
		childRelationships: [],
	},
	{
		name: "Task",
		label: "Task",
		fields: [
			field("Id", "id", system),
			field("Subject", "string"),
			field("ActivityDate", "date"),
			lookup("WhatId", ["Account", "Case", "Opportunity"], "What"),
			lookup("OwnerId", ["Group", "User"], "Owner", { nillable: false, defaultedOnCreate: true }),
		],
		childRelationships: [],
	},
	{
		name: "User",
		label: "User",
		fields: [
			field("Id", "id", system),
			field("Username", "string", { nillable: false, idLookup: true }),
			field("Email", "email", { nillable: false }),
			field("LastName", "string", { nillable: false }),
			field("IsActive", "boolean", { nillable: false, defaultedOnCreate: true }),
		],
		childRelationships: [],
	},
];
