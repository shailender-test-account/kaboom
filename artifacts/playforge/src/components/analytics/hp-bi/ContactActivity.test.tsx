// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ContactActivity, { actionLabel, isEligibleRecord } from "./ContactActivity";
import { matchesContribution } from "./contributions";
import type { HpBiDetail, HpBiRecord } from "./types";

afterEach(cleanup);
const rec = (o: Partial<HpBiRecord>): HpBiRecord => ({ id: "r", accountId: 1, contactId: 1, kind: "digital", occurredAt: "2025-01-10T04:30:00Z", category: "PCs", product: "Laptop X", horizonMonths: null,
  source: "import", sourceName: "Launch page", status: null, orderValue: null, currency: null, ...o });
const detail = (records: HpBiRecord[]) => ({
  account: {}, members: [{ id: 1, name: "Asha Legal Pvt Ltd" }], months: [], records,
  contacts: [{ id: 1, name: "Asha Rao", email: "asha@x.in", title: "CIO", companyId: 1, score: 1, isNew: false },
    { id: 2, name: "Inactive Ian", email: "ian@x.in", title: null, companyId: 1, score: 0, isNew: false }],
}) as unknown as HpBiDetail;
const base = [
  rec({ id: "a", status: "email_open", externalEventId: "evt-open-1" }),
  rec({ id: "b", status: "email_click", occurredAt: "2025-01-11T18:29:59Z", externalEventId: "evt-click-2" }),
  rec({ id: "c", kind: "lead", status: "hot", occurredAt: "2025-01-12T00:00:00Z" }),
  rec({ id: "d", kind: "lead", status: "warm" }),
  rec({ id: "e", contactId: null, kind: "other", status: "questionnaire" }),
  rec({ id: "f", contactId: 99, kind: "digital", status: "page_view" }),
];

describe("ContactActivity", () => {
  it("shows full-period Hot and Warm flags even when the selected metric excludes leads", () => {
    render(<ContactActivity detail={detail(base)} metric="touchpoints" />);
    expect(screen.getByTestId("person-flag-1-hot")).toBeTruthy();
    expect(screen.getByTestId("person-flag-1-warm")).toBeTruthy();
    expect(screen.queryByTestId("person-flag-2-hot")).toBeNull();
    expect(screen.getByTestId("contribution-filter-hot").textContent).toBe("1 Hot contributors");
    fireEvent.click(screen.getByTestId("person-flag-1-hot"));
    expect(screen.getByTestId("contact-activity-record-c")).toBeTruthy();
    expect(screen.queryByTestId("contact-activity-record-a")).toBeNull();
    fireEvent.click(screen.getByTestId("contribution-reset"));
    expect(screen.getByTestId("contact-activity-record-a")).toBeTruthy();
  });
  it("counts form contributors once and shows non-lead forms without fabricating Hot or Warm", () => {
    const forms = [rec({ id: "form:12", contactId: 2, kind: "other", source: "journey form", status: "form_submitted", product: null }),
      rec({ id: "form:13", contactId: 2, kind: "other", source: "journey form", status: "form_submitted" }),
      rec({ id: "form:14", contactId: null, source: "journey form" })];
    const d = { ...detail(base), formEvidence: forms };
    render(<ContactActivity detail={d} metric="contacts" />);
    expect(screen.getByTestId("contribution-filter-forms").textContent).toBe("1 form contributors");
    expect(screen.getByTestId("person-flag-2-forms")).toBeTruthy();
    expect(screen.queryByTestId("person-flag-2-warm")).toBeNull();
    fireEvent.click(screen.getByTestId("person-flag-2-forms"));
    expect(screen.getByTestId("contact-activity-record-form:12")).toBeTruthy();
    expect(screen.queryByTestId("contact-activity-record-form:14")).toBeNull();
  });
  it("opens complete source evidence and returns without losing the selected person", () => {
    render(<ContactActivity detail={detail(base)} metric="contacts" />);
    fireEvent.click(screen.getByTestId("contact-activity-person-1"));
    fireEvent.click(screen.getByTestId("inspect-record-c"));
    const dialog = screen.getByTestId("activity-evidence-inspection");
    expect(dialog.textContent).toContain("Source record details");
    expect(dialog.textContent).toContain("Laptop X");
    expect(dialog.textContent).toContain("Occurred at (IST)");
    fireEvent.click(screen.getByTestId("activity-inspection-back"));
    expect(screen.queryByTestId("activity-evidence-inspection")).toBeNull();
    expect(screen.getByTestId("contact-activity-person-1").getAttribute("aria-pressed")).toBe("true");
  });
  it("does not turn clicks, invitations, attendance, or scores into form/qualification flags", () => {
    for (const status of ["form_view", "form_click", "email_click", "page_view"]) expect(matchesContribution(rec({ status }), "forms")).toBe(false);
    expect(matchesContribution(rec({ kind: "attendance", status: "hot" }), "hot")).toBe(false);
    expect(isEligibleRecord(rec({ kind: "lead", status: "warm" }), "warm")).toBe(true);
    expect(isEligibleRecord(rec({ kind: "digital", status: "warm" }), "warm")).toBe(false);
  });
  it("labels opens vs clicks and feedback, filters kinds", () => {
    expect(actionLabel({ kind: "digital", status: "email_open" })).toMatch(/not a verified click/);
    expect(actionLabel({ kind: "digital", status: "email_click" })).toBe("Email link click");
    expect(actionLabel({ kind: "other", status: "x" })).toBe("Feedback response");
    expect(actionLabel({ kind: "interest", status: null })).toBe("Product interest");
    expect(isEligibleRecord(rec({ contactId: null }), "engagedContacts")).toBe(false);
    expect(isEligibleRecord(rec({ kind: "lead", status: "warm" }), "hot")).toBe(false);
  });
  it("shows IST, source ids, multiple records per person, and explicit unattributed", () => {
    render(<ContactActivity detail={detail(base)} metric="touchpoints" />);
    expect(screen.getAllByText(/IST$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("10 Jan 2025, 10:00:00 IST").length).toBeGreaterThan(0);
    expect(screen.getByText(/Source ID: evt-open-1/)).toBeTruthy();
    expect(screen.getByTestId("contact-activity-person-1").closest("tr")!.textContent).toContain("Asha Legal Pvt Ltd");
    expect(screen.getByTestId("contact-activity-person-unattributed")).toBeTruthy();
    expect(screen.getByTestId("contact-activity-person-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("contact-activity-person-2")).toBeNull();
    expect(screen.getByTestId("contact-activity-summary").textContent).toMatch(/duplicate uploads remain visible/);
  });
  it("opens and clicks are distinct actions via filter", () => {
    render(<ContactActivity detail={detail(base)} metric="touchpoints" />);
    fireEvent.change(screen.getByTestId("contact-activity-action"), { target: { value: "Email link click" } });
    const list = screen.getByTestId("contact-activity-records");
    expect(within(list).getAllByText(/Email link click/).length).toBe(1);
    expect(within(list).queryByText(/Email open/)).toBeNull();
  });
  it("hot filter only includes hot leads", () => {
    render(<ContactActivity detail={detail(base)} metric="hot" />);
    const list = screen.getByTestId("contact-activity-records");
    expect(list.querySelectorAll("li").length).toBe(1);
    expect(screen.getByTestId("contact-activity-record-c")).toBeTruthy();
  });
  it("contacts metric includes inactive roster contacts; select and clear", () => {
    render(<ContactActivity detail={detail(base)} metric="contacts" />);
    expect(screen.getByTestId("contact-activity-person-2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("contact-activity-person-2"));
    expect(screen.getByTestId("contact-activity-records-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("contact-activity-person-1"));
    expect(screen.queryByTestId("contact-activity-record-e")).toBeNull();
    expect(screen.getByTestId("contact-activity-record-a")).toBeTruthy();
    fireEvent.click(screen.getByTestId("contact-activity-all-people"));
    expect(screen.getByTestId("contact-activity-record-e")).toBeTruthy();
  });
  it("searches by email and paginates 25", () => {
    const many = Array.from({ length: 30 }, (_, i) => rec({ id: `m${i}`, occurredAt: `2025-02-${String(i + 1).padStart(2, "0")}T05:00:00Z` }));
    render(<ContactActivity detail={detail(many)} metric="touchpoints" />);
    expect(screen.getByTestId("contact-activity-records").querySelectorAll("li").length).toBe(25);
    fireEvent.click(screen.getByTestId("contact-activity-records-page-next"));
    expect(screen.getByTestId("contact-activity-records").querySelectorAll("li").length).toBe(5);
    fireEvent.change(screen.getByTestId("contact-activity-search"), { target: { value: "nobody@" } });
    expect(screen.getByTestId("contact-activity-people-empty")).toBeTruthy();
  });
});
