import { describe, expect, it } from "vitest";
import { matchHpRoster } from "./hpRosterMatch";
const row = (id: string, name: string) => ({ hp_id: id, name, aliases: [name], parent_key: "parent" });
describe("HP roster identity preservation", () => {
  it("adopts an existing CRM baseline with an empty HP ID without duplicating it", () => {
    const [d] = matchHpRoster([row("A", "Example Ltd")], [{ crmId: 4, name: " example LTD ", hp_id: null }]);
    expect(d.existing?.crmId).toBe(4); expect(d.reason).toBeNull();
  });
  it("uses stable HP ID before changed or ambiguous legal names", () => {
    const [d] = matchHpRoster([row("A", "New Name")], [{ crmId: 4, name: "Old Name", hp_id: "A" }, { crmId: 5, name: "New Name" }]);
    expect(d.existing?.crmId).toBe(4);
  });
  it("holds ambiguous owned names and conflicting explicit IDs rather than creating a duplicate", () => {
    expect(matchHpRoster([row("A", "Same")], [{ crmId: 1, name: "Same" }, { crmId: 2, name: "Same" }])[0].reason).toContain("Ambiguous");
    expect(matchHpRoster([row("A", "Same")], [{ crmId: 1, name: "Same", hp_id: "B" }])[0].reason).toContain("different HP ID");
  });
  it("checks source name uniqueness across the entire roster, not just a 500-row batch", () => {
    const input = Array.from({ length: 501 }, (_, i) => row(`ID${i}`, i === 0 || i === 500 ? "Same" : `Company ${i}`));
    const decisions = matchHpRoster(input, [{ crmId: 1, name: "Same" }]);
    expect(decisions.filter(d => d.reason)).toHaveLength(2);
    expect(decisions.filter(d => d.existing)).toHaveLength(0);
  });
  it("respects exact owned aliases, but never guesses a fuzzy match", () => {
    expect(matchHpRoster([row("A", "Alias")], [{ crmId: 1, name: "Canonical", aliases: ["Alias"] }])[0].existing?.crmId).toBe(1);
    expect(matchHpRoster([row("A", "Alias Pvt Ltd")], [{ crmId: 1, name: "Alias" }])[0].existing).toBeUndefined();
  });
  it("allows explicit owned review but rejects a target already claiming another HP ID", () => {
    const approvals = new Map([["A", 2]]);
    expect(matchHpRoster([row("A", "Ambiguous")], [{ crmId: 1, name: "Ambiguous" }, { crmId: 2, name: "Ambiguous" }], approvals)[0].existing?.crmId).toBe(2);
    expect(matchHpRoster([row("A", "Ambiguous")], [{ crmId: 2, name: "Other", hp_id: "B" }], approvals)[0].reason).toContain("different HP ID");
  });
});
