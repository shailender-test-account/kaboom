import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { hasLinkedCrmRecords } from "../lib/manualInboundAccount";

describe("manual inbound client correction", () => {
  it.each(["contacts", "deals"])("blocks changing a company's client when it has linked %s", async (linkedTable) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ linked: true }] });
    expect(await hasLinkedCrmRecords({ query } as unknown as PoolClient, 7, 42)).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining(`FROM ${linkedTable}`), [7, 42]);
  });

  it("allows a company without linked CRM records to change client", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ linked: false }] });
    expect(await hasLinkedCrmRecords({ query } as unknown as PoolClient, 7, 42)).toBe(false);
  });
});