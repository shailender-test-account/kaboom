import { describe, expect, it } from "vitest";
import {
  getListHpParentViewsUrl, getCreateHpParentViewUrl,
  getUpdateHpParentViewUrl, getDeleteHpParentViewUrl,
} from "@workspace/api-client-react";

describe("generated parent view CRUD URLs", () => {
  it("sends required client scope for list, create, update and delete", () => {
    const clientId = 731, id = 823;
    const urls = [
      getListHpParentViewsUrl({ clientId }),
      getCreateHpParentViewUrl({ clientId }),
      getUpdateHpParentViewUrl(id, { clientId }),
      getDeleteHpParentViewUrl(id, { clientId }),
    ];
    for (const url of urls) {
      expect(new URL(url, "http://fixture.invalid").searchParams.get("clientId")).toBe(String(clientId));
    }
    expect(urls[0].split("?")[0]).toBe("/api/analytics/hp-bi/pivot/views");
    expect(urls[1].split("?")[0]).toBe("/api/analytics/hp-bi/pivot/views");
    expect(urls[2].split("?")[0]).toBe(`/api/analytics/hp-bi/pivot/views/${id}`);
    expect(urls[3].split("?")[0]).toBe(`/api/analytics/hp-bi/pivot/views/${id}`);
  });
});
