import { expect, it } from "vitest";
import { getGetEngagementHistoryUrl } from "@workspace/api-client-react";

it("serializes account, contact, parent/client and paging without dropping scope", () => {
  const url = getGetEngagementHistoryUrl({ parentKey: "Parent & sibling", clientId: 9, page: 2, pageSize: 50 });
  const params = new URL(url, "https://example.test").searchParams;
  expect(params.get("parentKey")).toBe("Parent & sibling");
  expect(params.get("clientId")).toBe("9");
  expect(params.get("page")).toBe("2");
  expect(params.get("pageSize")).toBe("50");
  expect(getGetEngagementHistoryUrl({ companyId: 17 })).toContain("companyId=17");
  expect(getGetEngagementHistoryUrl({ contactId: 29 })).toContain("contactId=29");
});
