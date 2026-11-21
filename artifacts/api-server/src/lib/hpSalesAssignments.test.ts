import { describe, expect, it } from "vitest";
import { hpSalesAssignments } from "./hpSalesAssignments";

describe("HP sales ownership display", () => {
  it("preserves supplied emails and roles, consolidates duplicate owners and retains subsidiary attribution", () => {
    expect(hpSalesAssignments([
      { company_id: 1, name: "First", hp_id: "HP-1", eam_email: "Manager@hp.example", pam_email: "print@hp.example" },
      { company_id: 2, name: "Second", eam_email: "manager@hp.example", isr_email: "inside@hp.example" },
      { company_id: 2, name: "Second", eam_email: "manager@hp.example" },
    ])).toEqual([
      { role: "EAM", email: "Manager@hp.example", accounts: [{ id: 1, name: "First", hpId: "HP-1" }, { id: 2, name: "Second", hpId: null }] },
      { role: "PAM", email: "print@hp.example", accounts: [{ id: 1, name: "First", hpId: "HP-1" }] },
      { role: "ISR", email: "inside@hp.example", accounts: [{ id: 2, name: "Second", hpId: null }] },
    ]);
  });
  it("does not infer ownership from contacts or old source variants; blank placeholders stay unassigned", () => {
    expect(hpSalesAssignments([{ company_id: 1, name: "Blank", eam_email: "-", pam_email: "N/A",
      rm_email: null, isr_email: "", email: "prospect@example.invalid",
      variants: [{ eam_email: "historical@hp.example" }] }])).toEqual([]);
  });
});
