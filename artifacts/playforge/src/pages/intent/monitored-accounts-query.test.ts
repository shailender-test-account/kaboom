import {expect,it} from "vitest";
import {monitoredAccountsQuery} from "./monitored-accounts-query";

it("does not hide a selected account's news when its interpretation is incomplete",()=>{
  const detail=monitoredAccountsQuery(1,"",266737);
  expect(detail.params.get("completeResearch")).toBe("false");
  expect(detail.params.get("accountId")).toBe("266737");
  expect(detail.queryKey).toContain("account-research");
});
it("keeps incomplete research out of the curated dashboard count and list",()=>{
  const list=monitoredAccountsQuery(2,"concentrix");
  expect(list.params.get("completeResearch")).toBe("true");
  expect(list.params.get("accountId")).toBeNull();
  expect(list.params.get("search")).toBe("concentrix");
  expect(list.queryKey).toContain("complete-research");
  expect(list.queryKey).not.toEqual(monitoredAccountsQuery(2,"concentrix",266737).queryKey);
});
