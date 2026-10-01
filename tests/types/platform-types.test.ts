/** Compile-time tests for record types, picklists, UI API records and limits. */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { PicklistOption } from "../../src/resources/sobject";
import type { LimitInfo } from "../../src/types/api";
import type { UiFieldValue } from "../../src/types/platform";
import type { Case, SObjectRegistry } from "../fixtures/generated-sobjects";
import { createClient, FakeTransport } from "../helpers/fake-transport";

const sf = createClient<SObjectRegistry>(new FakeTransport());

describe("platform typing", () => {
	it("types record types, picklists and UI API fields", () => {
		const run = async (): Promise<void> => {
			expectTypeOf(await sf.sobject("Case").recordTypeId("Complaint")).toEqualTypeOf<string>();
			// @ts-expect-error not a record type of Case
			await sf.sobject("Case").recordTypeId("Incident");
			// @ts-expect-error Account has no record types in the fixture
			await sf.sobject("Account").recordTypeId("Complaint");

			const statuses = await sf.sobject("Case").picklistValues("Status", { recordType: "Question" });
			expectTypeOf(statuses).toEqualTypeOf<PicklistOption<Case["Status"]>[]>();

			const record = await sf.uiApi.record("Case", "500A", { fields: ["Status", "IsClosed"] });
			expectTypeOf(record.fields.Status).toEqualTypeOf<UiFieldValue<Case["Status"]>>();
			expectTypeOf(record.fields.IsClosed.value).toEqualTypeOf<boolean>();
			// @ts-expect-error Bogus is not a Case field
			await sf.uiApi.record("Case", "500A", { fields: ["Bogus"] });

			const limits = await sf.limits();
			expectTypeOf(limits.DailyApiRequests).toEqualTypeOf<LimitInfo | undefined>();
		};
		expect(typeof run).toBe("function");
	});
});
