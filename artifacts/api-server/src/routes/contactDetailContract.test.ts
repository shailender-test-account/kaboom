import { describe, expect, it } from "vitest";
import { CreateContactBody, GetContactResponse, UpdateContactBody } from "@workspace/api-zod";

const detail = {
  id: 17, tenantId: 1, clientId: 2, clientName: "Example client",
  companyId: 3, companyName: "Example company",
  firstName: "Alex", lastName: "Example", email: "alex@example.invalid",
  phone: null, title: null, tags: ["customer"], leadScore: 42, status: "active",
  stage: "engage", source: "manual", lastActivity: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
  website: "https://example.invalid", linkedinUrl: null, city: "Pune", country: "India",
  intentScore: 42, rawIntentScore: 42, intentState: "Evaluating-Engage",
  suggestedNextAction: null, distinctActiveDays: 3, freqScore: 1.5,
  maxStageScore: 10, engagementScore: 8, velocityBonus: 10,
  accountBonus: 10, accountColleagues: 2, gccAlternatives: [],
};

describe("contact detail response contract", () => {
  it("preserves profile, stage and score breakdown fields returned by GET", () => {
    const parsed = GetContactResponse.parse(detail);
    for (const [key, value] of Object.entries(detail)) {
      if (key !== "createdAt" && key !== "updatedAt") {
        expect(parsed).toHaveProperty(key, value);
      }
    }
    expect(GetContactResponse.parse({ ...detail, dnc: true }).dnc).toBe(true);
    expect(parsed).not.toHaveProperty("dnc");
  });

  it("accepts absent optional fields and explicit nulls from existing detail responses", () => {
    const nullable = Object.fromEntries([
      "clientId", "clientName", "companyId", "companyName", "website", "linkedinUrl",
      "city", "country", "source", "intentScore", "rawIntentScore", "intentState",
      "suggestedNextAction", "distinctActiveDays", "freqScore", "maxStageScore",
      "engagementScore", "velocityBonus", "accountBonus", "accountColleagues",
    ].map(key => [key, null]));
    expect(GetContactResponse.safeParse({ ...detail, ...nullable }).success).toBe(true);
    const { id, tenantId, firstName, lastName, email, tags, leadScore, status, createdAt, updatedAt } = detail;
    expect(GetContactResponse.safeParse({
      id, tenantId, clientId: null, firstName, lastName, email, tags, leadScore, status, createdAt, updatedAt,
    }).success).toBe(true);
  });

  it("keeps generated create and update permissions unchanged", () => {
    expect(Object.keys(CreateContactBody.shape).sort()).toEqual([
      "clientId", "companyId", "email", "firstName", "lastName", "phone", "status", "tags", "title",
    ]);
    expect(Object.keys(UpdateContactBody.shape).sort()).toEqual([
      "companyId", "email", "firstName", "lastName", "leadScore", "phone", "status", "tags", "title",
    ]);
    expect(UpdateContactBody.parse({
      firstName: "Updated", clientName: "spoofed", intentScore: 100, accountBonus: 100,
      gccAlternatives: [{ alternateEmail: "spoofed@example.invalid" }],
    })).toEqual({ firstName: "Updated" });
  });
});
