// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import type { HpBiDetail } from "./types";
import StructuredAccountView from "./StructuredAccountView";
import { quarters, categoryRows, readLayout, writeLayout, opportunityRecords } from "./structured";
import OpportunityPeopleDialog from "./OpportunityPeopleDialog";

vi.mock("@/components/EngagementHistory", () => ({ default: () => null }));
vi.mock("@/components/intent/SubmissionDateEditor", () => ({ default: () => null }));
vi.mock("./ContactActivity", () => ({ default: ({ metric }: { metric: string }) => <div data-testid="contact-activity">{metric}</div> }));
vi.mock("./ActivityEvidenceDialog", () => ({ default: () => null }));
vi.mock("./CrmDealQuality", () => ({ default: () => null }));
afterEach(cleanup);
const mk = (i: number, extra = {}) => ({ label: `M${i}`, start: new Date(Date.UTC(2026, 10 + i, 1) - 330 * 60000).toISOString(), touchpoints: i === 0 ? 2 : 0, contacts: 5, invitations: 1, attendance: 0, digital: 1, content: 0, other: 0, leads: 0, hot: 0, warm: 0, opportunities: 0, values: i === 0 ? { INR: 100 } : i === 1 ? { USD: 5 } : {}, categories: [], isFuture: i > 6, ...extra });
const detail = (over = {}) => ({ account: { id: 1, name: "Acme Legal", parentName: "Vantage Group", segment: "GCC", rad: "Retention", industry: null, employeeSize: null, score: 12, contacts: 2, engagedContacts: 1, status: "Hot" },
  members: [{ id: 1, name: "A", dimensions: {}, variants: [], buyerCategories: ["PCs"], whitespaceCategories: ["Printers"], abmClassification: "Tier 1", buyingBehavior: null, globalAccount: true, profiled: null, propensity: null },
    { id: 2, name: "B", dimensions: {}, variants: [], buyerCategories: [], whitespaceCategories: [], abmClassification: "Tier 2", buyingBehavior: null, globalAccount: true, profiled: null, propensity: null }],
  contacts: [], months: Array.from({ length: 12 }, (_, i) => mk(i)),
  records: [{ id: "r1", accountId: 1, contactId: 7, kind: "opportunity", occurredAt: new Date(Date.UTC(2026, 10, 5)).toISOString(), category: "Printers", product: "LaserJet", horizonMonths: null, orderValue: 50, currency: "INR", source: "crm", sourceName: "CRM", status: null },
    { id: "r2", accountId: 1, contactId: 7, kind: "opportunity", occurredAt: new Date(Date.UTC(2026, 10, 6)).toISOString(), category: "Printers", product: "LaserJet", horizonMonths: null, orderValue: 70, currency: "INR", source: "crm", sourceName: "CRM", status: null, exclusionReasons: ["duplicate"] }],
  ...over }) as unknown as HpBiDetail;
const view = (d: HpBiDetail) => render(<StructuredAccountView d={d} filters={{ clientId: 1, year: 2027 }} parentKey="k" manage={<i />} profile={<i />} recordForm={<i />} />);

describe("structured account layout", () => {
  it("shows Buying Committee first, ahead of the long account context and workbook", () => {
    render(<StructuredAccountView d={detail()} filters={{ clientId: 1, year: 2027 }} parentKey="k" manage={<i />} profile={<i />} recordForm={<i />} committee={<p>Scoped committee contacts</p>} />);
    const sections = [...document.querySelectorAll("[data-testid^=section-]")].map(e => e.getAttribute("data-testid"));
    expect(sections[0]).toBe("section-committee");
    expect(sections[1]).toBe("section-context");
    expect(screen.getByText("Scoped committee contacts")).toBeTruthy();
    expect(screen.getByTestId("section-committee").compareDocumentPosition(screen.getByTestId("workbook-profile"))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("renders five sections in order with honest missing values", () => {
    view(detail());
    const ids = [...document.querySelectorAll("[data-testid^=section-]")].map(e => e.getAttribute("data-testid"));
    expect(ids).toEqual(["section-context", "section-opportunity", "section-engagement", "section-journey", "section-relationship"]);
    expect(screen.getByTestId("ctx-Industry").textContent).toBe("Not available");
    expect(screen.getByTestId("ctx-ABM classification").textContent).toContain("Mixed");
    expect(screen.getByTestId("relationship-score").textContent).toBe("12");
  });
  it("shows the city and source contact details above the full workbook without expanding a hidden section", () => {
    const d = detail();
    d.members[0].dimensions._gccProfiling = [{ sourceRow: 2, fileName: "profiling.xlsx", sheet: "GCC", contactId: 9,
      values: { name: "Directory Person", city: "Mumbai", email: "person@example.invalid", phone: "9876543210" } }];
    view(d);
    expect(screen.getByTestId("ctx-City").textContent).toContain("Mumbai");
    expect(screen.getByTestId("gcc-profiling").hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("gcc-profile-row").textContent).toContain("person@example.invalid");
    expect(screen.getByTestId("gcc-profile-row").textContent).toContain("9876543210");
    expect(screen.getByTestId("gcc-profiling").compareDocumentPosition(screen.getByTestId("workbook-profile"))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("shows explicit whitespace with account-level flags labeled and no inference", () => {
    view(detail());
    expect(screen.getByTestId("ws-Printers").textContent).toContain("LaserJet");
    expect(screen.getByTestId("opportunity-account-flags").textContent).toContain("not a per-category claim");
    cleanup();
    view(detail({ members: [] }));
    expect(screen.getByTestId("opportunity-whitespace").textContent).toContain("Not available");
  });
  it("opens category-specific people and products from the opportunity counts without including other interests", () => {
    const base = detail().records[0];
    const d = detail({
      contacts: [{ id: 7, name: "Printer Buyer", email: "buyer@example.test", title: "IT Manager", companyId: 1, score: 0, isNew: false },
        { id: 8, name: "Security Buyer", email: "security@example.test", title: "Security Manager", companyId: 2, score: 0, isNew: false }],
      records: [
        { ...base, id: "touch", kind: "interest", orderValue: null, currency: null },
        { ...base, id: "lead", kind: "lead", status: "Warm", orderValue: null, currency: null },
        { ...base, id: "security", contactId: 8, accountId: 2, kind: "interest", category: "Security", product: "Security service" },
      ],
      recordedInterests: [{ accountId: 2, contactId: 8, product: "Historical unrelated product", source: "Event", occurredAt: "2020-01-01" }],
    });
    view(d);
    fireEvent.click(screen.getByRole("button", { name: "View engaged contacts for Printers" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Printer Buyer")).toBeTruthy();
    expect(within(dialog).getByText("LaserJet")).toBeTruthy();
    expect(within(dialog).getByText(/1 identified person · 1 supporting records/)).toBeTruthy();
    expect(within(dialog).queryByText("Security Buyer")).toBeNull();
    expect(within(dialog).queryByText("Historical unrelated product")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to account" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View leads for Printers" }));
    expect(within(screen.getByRole("dialog")).getByText(/lead · Warm/)).toBeTruthy();
  });
  it("keeps category drill-down predicates identical to the displayed counts and value", () => {
    const d = detail();
    for (const row of categoryRows(d)) {
      expect(opportunityRecords(d, "touchpoints", row.category)).toHaveLength(row.touches);
      expect(new Set(opportunityRecords(d, "engagedContacts", row.category).map(r => r.contactId)).size).toBe(row.contacts);
      expect(opportunityRecords(d, "leads", row.category)).toHaveLength(row.leads);
      expect(opportunityRecords(d, "opportunities", row.category)).toHaveLength(row.opps);
      const value = opportunityRecords(d, "value", row.category).reduce<Record<string, number>>((s, r) => {
        s[r.currency!] = (s[r.currency!] ?? 0) + r.orderValue!; return s;
      }, {});
      expect(value).toEqual(row.tov);
    }
  });
  it("pages the matching source records and preserves account-only attribution and source inspection", () => {
    const base = detail().records[0], inspect = vi.fn(), close = vi.fn();
    const d = detail({ records: Array.from({ length: 11 }, (_, i) => ({ ...base, id: `record-${i}`, contactId: null, kind: "lead" })) });
    render(<OpportunityPeopleDialog selection={{ category: "Printers", metric: "leads" }} detail={d} onClose={close} onInspect={inspect} />);
    expect(screen.getByText(/0 identified people · 11 supporting records/)).toBeTruthy();
    expect(screen.getAllByText("Account-level · no person attributed")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Next records" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(screen.getAllByText("Account-level · no person attributed")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /View source record for account-level activity/ }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ id: "record-10", contactId: null }));
  });
  it("explains zero counts instead of showing contacts from another category", () => {
    view(detail());
    fireEvent.click(screen.getByRole("button", { name: "View leads for PCs" }));
    expect(within(screen.getByRole("dialog")).getByText(/No supporting records/)).toBeTruthy();
  });
  it("keeps currencies separate, excludes non-money records, and groups four quarters", () => {
    const d = detail();
    const q = quarters(d);
    expect(q).toHaveLength(4);
    expect(q[0].values).toEqual({ INR: 100, USD: 5 });
    expect(q[0].contacts).toBeNull(); // Opportunities alone are not marketing engagement.
    expect(q[3].contacts).toBe(0);
    expect(categoryRows(d).find(c => c.category === "Printers")!.tov).toEqual({ INR: 50 });
  });
  it("shows selected FY dates and zero/future months", () => {
    view(detail());
    expect(screen.getByTestId("section-journey").textContent).toContain("FY2027 (Nov 2026 - Oct 2027)");
    expect(screen.getByTestId("journey-month-M11").textContent).toContain("Not started");
  });
  it("persists layout per client with structured default", () => {
    localStorage.clear();
    expect(readLayout(1)).toBe("structured");
    writeLayout(1, "original");
    expect(readLayout(1)).toBe("original");
    expect(readLayout(2)).toBe("structured");
  });
  it("deduplicates quarterly engaged people and preserves separate response/lead measures", () => {
    const base = detail().records[0];
    const response = { ...base, id: "response", kind: "other", qualificationRecordId: "lead", orderValue: null, currency: null };
    const lead = { ...base, id: "lead", kind: "lead", responseRecordId: "response", orderValue: null, currency: null };
    const interest = { ...base, id: "interest", kind: "interest", orderValue: null, currency: null };
    const repeatedContact = { ...base, id: "digital", kind: "digital", occurredAt: mk(1).start, orderValue: null, currency: null };
    const d = detail({ records: [response, lead, interest, repeatedContact] });
    expect(quarters(d)[0].contacts).toBe(1);
    const category = categoryRows(d).find(c => c.category === "Printers")!;
    expect(category.contacts).toBe(1);
    expect(category.touches).toBe(3);
    expect(category.leads).toBe(1);
    expect(category.tov).toEqual({});
  });
  it("opens the metric chosen in the parent account table", () => {
    render(<StructuredAccountView d={detail()} filters={{ clientId: 1, year: 2027 }} parentKey="k" initialMetric="hot" manage={null} profile={null} recordForm={null} />);
    expect(screen.getByTestId("contact-activity").textContent).toBe("hot");
    expect(screen.getByTestId("detail-metric-hot").getAttribute("aria-pressed")).toBe("true");
  });
  it("retains future booked outcomes rather than hiding them as not started", () => {
    const d = detail();
    d.months[11] = { ...d.months[11], closedWon: 1, bookedValues: { INR: 42 } };
    view(d);
    expect(screen.getByTestId("journey-month-M11").textContent).toContain("1 won");
    expect(screen.getByTestId("journey-month-M11").textContent).not.toContain("Not started");
  });
});
