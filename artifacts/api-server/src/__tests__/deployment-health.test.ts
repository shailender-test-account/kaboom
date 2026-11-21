import { describe, expect, it } from "vitest";
import request from "supertest";

process.env.SESSION_SECRET ||= "deployment-health-test-secret";

const { default: app } = await import("../app");

describe("deployment health checks", () => {
  it.each(["/api", "/api/healthz"])("serves %s without authentication", async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});