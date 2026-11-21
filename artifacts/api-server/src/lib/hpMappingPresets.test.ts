import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import * as XLSX from "xlsx";
import { pool } from "@workspace/db";
import hpBiRouter from "../routes/hpBi";
import { mappingErrors } from "./hpMappingValidation";

describe("HP saved mapping presets", () => {
  let tenantId: number, otherTenantId: number, hp: number, hp2: number, other: number, foreignHp: number;
  let server: Server, url: string;
  const headers = { "x-role": "admin", "Content-Type": "application/json" };
  const mappings = { "Custom ID": "hp_id", "Custom name": "legal_name" };
  const input = { name: "Monthly roster", kind: "accounts", headers: ["Custom ID", "Custom name"], mappings };
  beforeAll(async () => {
    tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Preset tests',$1) RETURNING id", [`preset-tests-${Date.now()}`])).rows[0].id;
    otherTenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Foreign preset tests',$1) RETURNING id", [`foreign-preset-${Date.now()}`])).rows[0].id;
    hp = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id;
    hp2 = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP India') RETURNING id", [tenantId])).rows[0].id;
    other = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Another client') RETURNING id", [tenantId])).rows[0].id;
    foreignHp = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [otherTenantId])).rows[0].id;
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => Boolean(req.headers["x-role"]);
      req.user = { tenantId: req.headers["x-foreign"] ? otherTenantId : tenantId, role: req.headers["x-role"], id: null };
      req.log = { warn() {} }; next();
    });
    app.use(hpBiRouter);
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as any).port}/analytics/hp-bi`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const id of [tenantId, otherTenantId].filter(Boolean)) {
      for (const table of ["hp_mapping_presets", "hp_bi_records", "hp_bi_matches", "hp_bi_imports", "hp_bi_contacts", "hp_account_profiles", "companies", "clients"])
        await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
      await pool.query("DELETE FROM tenants WHERE id=$1", [id]);
    }
  });
  const endpoint = (suffix = "", client = hp) => `${url}/mapping-presets${suffix}?clientId=${client}`;
  const create = (body: unknown, client = hp) => fetch(endpoint("", client), { method: "POST", headers, body: JSON.stringify(body) });
  it("requires admin permissions for every preset action and HP tenant/client scope", async () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const path = endpoint(method === "PATCH" || method === "DELETE" ? "/1" : "") + (method === "GET" ? "&kind=accounts" : "");
      expect((await fetch(path, { method })).status).toBe(401);
      expect((await fetch(path, { method, headers: { "x-role": "user" } })).status).toBe(403);
    }
    expect((await create(input, other)).status).toBe(404);
    expect((await create(input, foreignHp)).status).toBe(404);
    expect((await fetch(endpoint() + "&kind=accounts", { headers: { ...headers, "x-foreign": "1" } })).status).toBe(404);
  });
  it("persists independently by import kind/client, supports rename/update/delete and guards foreign IDs", async () => {
    const created = await create(input); expect(created.status).toBe(201);
    const preset = await created.json() as any;
    expect(preset).toMatchObject(input);
    const list = await fetch(endpoint() + "&kind=accounts", { headers });
    expect(await list.json()).toEqual([preset]); // separate request/session readback
    expect((await create(input)).status).toBe(409);
    expect((await create(input, hp2)).status).toBe(201);
    expect((await create({ ...input, kind: "activities", mappings: { "Custom ID": "hpId", "Custom name": "accountName" } })).status).toBe(201);
    expect((await fetch(endpoint() + "&kind=activities", { headers }).then(r => r.json()) as any[])).toHaveLength(1);
    for (const method of ["PATCH", "DELETE"]) {
      expect((await fetch(endpoint(`/${preset.id}`, hp2), { method, headers, ...(method === "PATCH" ? { body: JSON.stringify({ name: "Wrong" }) } : {}) })).status).toBe(404);
    }
    const renamed = await fetch(endpoint(`/${preset.id}`), { method: "PATCH", headers, body: JSON.stringify({ name: " Revised roster " }) });
    expect(renamed.status).toBe(200); expect(await renamed.json()).toMatchObject({ name: "Revised roster", mappings });
    const changed = await fetch(endpoint(`/${preset.id}`), { method: "PATCH", headers, body: JSON.stringify({ headers: ["ID", "Name"], mappings: { ID: "UNIQUE ID", Name: "accountName" } }) });
    expect(changed.status).toBe(200); expect(await changed.json()).toMatchObject({ headers: ["ID", "Name"], mappings: { ID: "UNIQUE ID", Name: "accountName" } });
    const invalid = await fetch(endpoint(`/${preset.id}`), { method: "PATCH", headers, body: JSON.stringify({ headers: ["Name"] }) });
    expect(invalid.status).toBe(400);
    expect((await fetch(endpoint(`/${preset.id}`), { method: "DELETE", headers })).status).toBe(204);
    expect((await fetch(endpoint(`/${preset.id}`), { method: "DELETE", headers })).status).toBe(404);
    expect(await fetch(endpoint() + "&kind=accounts", { headers }).then(r => r.json())).toEqual([]);
  });
  it("validates names, kinds, headings and targets without guessing", async () => {
    for (const body of [
      { ...input, name: " " }, { ...input, name: "x".repeat(101) }, { ...input, kind: "bad" },
      { ...input, headers: [] }, { ...input, headers: ["Custom ID", "Custom ID"] },
      { ...input, mappings: { Missing: "hp_id" } }, { ...input, mappings: { "Custom ID": "notAField" } },
      { ...input, headers: [" Custom ID"] },
    ]) expect((await create(body)).status).toBe(400);
    expect(mappingErrors("accounts", ["Custom ID"], mappings).join()).toContain("Custom name");
    expect(mappingErrors("activities", ["Custom ID"], { "Custom ID": "top200" }).join()).toContain("Unsupported");
  });
  function upload(bodyMappings: Record<string, string>, value = "Preset Company", renamed = false) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[renamed ? "Renamed ID" : "Custom ID", "Custom name"], ["PRESET-ID", value]]), "Final");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }))]), "preset-test.xlsx");
    form.set("kind", "accounts"); form.set("mappings", JSON.stringify(bodyMappings));
    // This fixture represents an administrator who explicitly approved the roster.
    form.set("confirmAccounts", "true"); return form;
  }
  it("applies saved mappings through real uploads, rejects changed headers and preserves dedup/corrections/data on delete", async () => {
    const saved = await create({ ...input, name: "Repeat upload" }).then(r => r.json()) as any;
    const post = (preview: boolean, form: FormData) => fetch(`${url}/import${preview ? "/preview" : ""}?clientId=${hp}`, { method: "POST", headers: { "x-role": "admin" }, body: form });
    const preview = await post(true, upload(saved.mappings));
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({ errors: [], rows: 1 });
    for (let i = 0; i < 2; i++) {
      const result = await post(false, upload(saved.mappings));
      expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ created: i === 0 ? 1 : 0, imported: 1 });
    }
    const badPreview = await post(true, upload(saved.mappings, "Preset Company", true));
    expect(((await badPreview.json()) as any).errors.join()).toContain('Mapped heading "Custom ID" is missing');
    expect((await post(false, upload(saved.mappings, "Preset Company", true))).status).toBe(422);
    expect((await post(false, upload({ "Custom ID": "notAField" }))).status).toBe(422);
    const correction = await post(false, upload(saved.mappings, "Corrected Preset Company"));
    expect(correction.status).toBe(200);
    const profile = (await pool.query("SELECT company_id,legal_name,edits FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='PRESET-ID'", [tenantId])).rows[0];
    expect(profile.legal_name).toBe("Corrected Preset Company"); expect(profile.edits.length).toBeGreaterThan(0);
    expect((await fetch(endpoint(`/${saved.id}`), { method: "DELETE", headers })).status).toBe(204);
    expect((await pool.query("SELECT count(*) n FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='PRESET-ID'", [tenantId])).rows[0].n).toBe("1");
    expect((await pool.query("SELECT count(*) n FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2", [tenantId, hp])).rows[0].n).toBe("3");
  });
});
