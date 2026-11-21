// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountIntentTags from "./AccountIntentTags";
import { monitoringCoverage } from "./MonitoringCoverage";
import { sourceIntent } from "./sourceIntent";
import type { HpBiDetail } from "./types";

afterEach(cleanup);
const detail = (overrides: Partial<HpBiDetail> = {}) => ({
  members: [{ id: 1, name: "Account 1" }, { id: 2, name: "Account 2" }],
  intentSources: { gtm: [], journey: [] },
  monitoringContext: [{ accountId: 1, accountName: "Account 1", lastCheckedAt: "2026-10-21T05:56:00Z",
    runStatus: "completed", findings: [] }],
  ...overrides,
}) as HpBiDetail;

it("makes completed zero-result checks visible without manufacturing Cold or changing overall intent", () => {
  const d = detail();
  render(<AccountIntentTags d={d} />);
  expect(screen.getByText("Partly checked")).toBeTruthy();
  expect(screen.getByText(/1\/2 member accounts checked/)).toBeTruthy();
  expect(screen.getByText(/Last checked:/)).toBeTruthy();
  expect(screen.getByText(/No qualifying Hot\/Warm monitoring evidence/)).toBeTruthy();
  expect(sourceIntent(d)).toMatchObject({ overall: "Not available", statuses: { monitoring: "Not available" }, categories: [] });
});
it("explicitly identifies an unmonitored parent such as Genpact rather than borrowing another account's results", () => {
  render(<AccountIntentTags d={detail({ monitoringContext: [] })} />);
  expect(screen.getByText("Not checked")).toBeTruthy();
  expect(screen.getByText(/0\/2 member accounts checked/)).toBeTruthy();
});
it("shows checked coverage in Account Opportunity even when there is no Hot/Warm category", () => {
  render(<AccountIntentTags d={detail()} opportunities />);
  expect(screen.getByTestId("opportunity-source-intent")).toBeTruthy();
  expect(screen.getByText(/Monitoring: Partly checked/)).toBeTruthy();
  expect(screen.getByText(/No category-specific Hot\/Warm evidence available/)).toBeTruthy();
});
it("keeps approved category heat alongside operational completion", () => {
  const d = detail({ monitoringContext: [{ accountId: 1, accountName: "Account 1",
    lastCheckedAt: "2026-10-21T05:56:00Z", runStatus: "completed",
    findings: [{ evidenceId: 1, occurredAt: "2026-10-21T00:00:00Z", excerpt: "India expansion",
      sourceUrl: "https://example.com", heat: "Warm", nextAction: null,
      categories: [{ name: "IT Hardware", heat: "Warm", rationale: "Approved need" }] }] }] });
  render(<AccountIntentTags d={d} />);
  expect(screen.getByText("IT Hardware · Warm")).toBeTruthy();
  expect(screen.getByText(/1\/2 member accounts checked/)).toBeTruthy();
  expect(screen.queryByText(/No qualifying Hot\/Warm monitoring evidence/)).toBeNull();
  expect(sourceIntent(d).overall).toBe("Warm");
});
it("preserves previous completion while showing a failed or active latest attempt; ignores non-member accounts", () => {
  const d = detail();
  d.monitoringContext!.push(
    { accountId: 2, accountName: "Account 2", lastCheckedAt: null, runStatus: "running", findings: [] },
    { accountId: 99, accountName: "Not a member", lastCheckedAt: "2026-10-22T00:00:00Z", runStatus: "completed", findings: [] },
  );
  expect(monitoringCoverage(d)).toMatchObject({ total: 2, checked: 1, active: 1, label: "In progress",
    latest: "2026-10-21T05:56:00Z" });
  d.monitoringContext![1].runStatus = "failed";
  expect(monitoringCoverage(d)).toMatchObject({ checked: 1, failed: 1, label: "Latest check failed" });
});
it("shows genuine parent completion without inventing completed member checks", () => {
  const d = detail({ clientId: 9, monitoringContext: [{
    accountId: 99, analysisAccountId: 99, accountName: "GENPACT", researchScope: "parent",
    memberAccountIds: [1, 2], lastCheckedAt: "2026-11-03T04:19:34Z", runStatus: "completed", findings: [],
  }] });
  expect(monitoringCoverage(d)).toMatchObject({ checked: 0, parentChecked: 1, total: 2, label: "Parent checked" });
  render(<AccountIntentTags d={d} />);
  expect(screen.getByText("Parent checked")).toBeTruthy();
  expect(screen.getByText(/1\/1 parent organizations checked/)).toBeTruthy();
  expect(screen.queryByText(/No completed monitoring check/)).toBeNull();
  expect(screen.getByRole("link", { name: /View parent news/ }).getAttribute("href")).toContain("intent/accounts/99?clientId=9");
  expect(sourceIntent(d).overall).toBe("Not available");
});
it("ignores parent research for an unrelated member group", () => {
  const d = detail({ monitoringContext: [{
    accountId: 99, accountName: "Other parent", researchScope: "parent", memberAccountIds: [999],
    lastCheckedAt: "2026-11-03T04:19:34Z", runStatus: "completed", findings: [],
  }] });
  expect(monitoringCoverage(d)).toMatchObject({ checked: 0, parentChecked: 0, label: "Not checked" });
});
