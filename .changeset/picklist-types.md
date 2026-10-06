---
"@cerios/salesforce-sobjectly": minor
---

Named picklist types. Two new `picklists` modes give every picklist a named type, e.g. `CaseStatus.Working` and `Status: CaseStatus`:

- `picklists: "const"`: an `as const` object plus a type of the same name. The type is the same union as before, so plain strings keep working.
- `picklists: "enum"`: a TypeScript `enum`. Restricted picklists then only accept enum members.

Type names are the sObject and field in PascalCase (`Case.Status__c` → `CaseStatusCustom`). A name that clashes with a generated sObject, such as `CaseStatus`, gets the suffix `Picklist`. The default stays `"union"`, and its output is unchanged.
