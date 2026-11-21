import { describe, it, expect } from "vitest";
import { resolveMatrix, toPermissions, fillMatrix, errorMessage } from "./teamAccessModel";

describe("team access model", () => {
  it("admin resolves to manage everywhere", () => {
    expect(Object.values(resolveMatrix("admin", { dashboard: "none" })).every(v => v === "manage")).toBe(true);
  });
  it("null permissions use legacy role defaults", () => {
    expect(resolveMatrix("viewer", null).deals).toBe("view");
    expect(resolveMatrix("editor", null).deals).toBe("manage");
  });
  it("explicit map treats omitted keys as none", () => {
    const m = resolveMatrix("manager", { contacts: "view" });
    expect(m.contacts).toBe("view");
    expect(m.deals).toBe("none");
  });
  it("toPermissions omits none", () => {
    const m = fillMatrix("none"); m.deals = "manage";
    expect(toPermissions(m)).toEqual({ deals: "manage" });
  });
  it("reads ApiError data.error", () => {
    expect(errorMessage({ data: { error: "Cannot remove the last admin" } }, "x")).toBe("Cannot remove the last admin");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
