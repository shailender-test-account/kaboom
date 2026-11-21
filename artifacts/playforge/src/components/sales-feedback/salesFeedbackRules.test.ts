import { expect, it } from "vitest";
import { dateProblem } from "./ReviewDialog";
import { REVIEW_AFFECTED } from "@/hooks/use-sales-feedback";

it("requires an explicit non-future interaction date for qualification", () => {
  const now = new Date("2026-03-10T12:00:00").getTime();
  expect(dateProblem("", now)).toMatch(/import date is not used/);
  expect(dateProblem("2026-03-11T09:00", now)).toMatch(/future/);
  expect(dateProblem("2026-03-09T09:00", now)).toBeNull();
});

it("invalidates engagement, intent, HP analytics and priority queries after review", () => {
  const hit = (k: unknown[]) => REVIEW_AFFECTED.test(JSON.stringify(k));
  expect(hit(["/api/engagement-history", { contactId: 1 }])).toBe(true);
  expect(hit(["intent", "contacts", 3])).toBe(true);
  expect(hit(["analytics", "hp-bi", "priority"])).toBe(true);
  expect(hit(["templates", 4])).toBe(false);
});
