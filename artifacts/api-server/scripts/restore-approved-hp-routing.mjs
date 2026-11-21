/**
 * Approved Preview-only restoration. Production export is supplied separately
 * through read-only database tooling; this script never connects to production.
 * Usage: node scripts/restore-approved-hp-routing.mjs /tmp/export.json [--apply]
 * Copies configuration only, never contacts, enrollments, jobs or sender accounts.
 */
import fs from "node:fs/promises";
import pg from "pg";

const [file, mode] = process.argv.slice(2);
if (!file || (mode && mode !== "--apply")) throw new Error("Provide the approved export and optional --apply");
if (process.env.NODE_ENV === "production") throw new Error("Preview-only operation");
const data = JSON.parse(await fs.readFile(file, "utf8"));
const tenant = 1, owner = 9;
const expected = { journeys: 6, pages: 23, rules: 9, sequences: 3, steps: 8, templates: 2, forms: 3 };
for (const [key, count] of Object.entries(expected)) {
  if (data[key]?.length !== count) throw new Error(`Unexpected ${key} export; review again`);
}
for (const key of ["journeys", "rules"]) {
  if (data[key].some(row => row.tenant_id !== tenant || row.client_id !== owner)) throw new Error("Export outside approved HP scope");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const tables = ["journeys", "journey_pages", "email_templates", "email_sequences", "sequence_steps",
  "journey_forms", "intent_product_categories", "intent_product_subcategories", "intent_products",
  "intent_inbound_routing_rules"];
const columns = new Map();
const maps = Object.fromEntries(["journeys", "pages", "templates", "sequences", "steps", "forms",
  "categories", "subcategories", "products", "rules"].map(key => [key, new Map()]));
const required = (key, id) => {
  if (id == null) return null;
  const mapped = maps[key].get(Number(id));
  if (!mapped) throw new Error(`Unmapped ${key} reference ${id}`);
  return mapped;
};
const slugMap = new Map(data.journeys.map(j => [j.slug, `hp-preview-copy-${j.id}-${j.slug}`]));
const referenceKeys = {
  templateId: "templates", template_id: "templates", formId: "forms", form_id: "forms",
  journeyId: "journeys", journey_id: "journeys", pageId: "pages", page_id: "pages",
  sequenceId: "sequences", sequence_id: "sequences", enrollSequenceId: "sequences",
};
function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, referenceKeys[key] && v != null ? required(referenceKeys[key], v) : rewrite(v)]));
  if (typeof value === "string") {
    for (const [oldSlug, newSlug] of slugMap) value = value.replaceAll(`/j/${oldSlug}`, `/j/${newSlug}`);
  }
  return value;
}
async function insert(table, source, overrides = {}) {
  if (!tables.includes(table)) throw new Error("Unexpected table");
  const row = { ...source, ...overrides };
  for (const key of ["id", "created_at", "updated_at"]) delete row[key];
  const schema = columns.get(table);
  const keys = Object.keys(row).filter(key => schema.has(key));
  const values = keys.map(key => ["json", "jsonb"].includes(schema.get(key)) && row[key] != null
    ? JSON.stringify(row[key]) : row[key]);
  const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(",")})
    VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`;
  return Number((await client.query(sql, values)).rows[0].id);
}
async function catalog(table, key, rows, fields) {
  for (const row of rows ?? []) {
    const mapped = { ...row, ...fields(row), tenant_id: tenant };
    const clauses = ["tenant_id=$1", "lower(btrim(name))=lower(btrim($2))"];
    const params = [tenant, mapped.name];
    if (mapped.category_id != null) { params.push(mapped.category_id); clauses.push(`category_id=$${params.length}`); }
    const existing = await client.query(`SELECT * FROM "${table}" WHERE ${clauses.join(" AND ")}`, params);
    if (existing.rows.length > 1) throw new Error(`Ambiguous ${key}: ${row.name}`);
    if (key === "products" && existing.rows[0]?.active === false) throw new Error(`Existing product is inactive: ${row.name}`);
    if (key === "products" && existing.rows[0] && existing.rows[0].subcategory_id !== mapped.subcategory_id)
      throw new Error(`Existing product subcategory differs: ${row.name}`);
    maps[key].set(row.id, existing.rows[0]?.id ?? await insert(table, mapped));
  }
}
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1,$2)", [tenant, owner]);
  const hp = await client.query("SELECT name FROM clients WHERE tenant_id=$1 AND id=$2", [tenant, owner]);
  if (hp.rows[0]?.name !== "HP") throw new Error("Unexpected destination owner");
  const before = await client.query(`SELECT
    (SELECT count(*)::int FROM sequence_enrollments) AS enrollments,
    (SELECT count(*)::int FROM journey_contacts) AS journey_contacts,
    (SELECT count(*)::int FROM intent_inbound_submissions) AS submissions`);
  for (const table of tables) {
    const meta = await client.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [table]);
    columns.set(table, new Map(meta.rows.map(r => [r.column_name, r.data_type])));
  }
  for (const j of data.journeys) {
    const exists = await client.query("SELECT id FROM journeys WHERE slug=$1 OR (tenant_id=$2 AND client_id=$3 AND name=$4)",
      [slugMap.get(j.slug), tenant, owner, j.name]);
    if (exists.rowCount) throw new Error(`Journey already present: ${j.name}; refusing a duplicate or overwrite`);
  }
  if (mode !== "--apply") {
    console.log(JSON.stringify({ dryRun: true, approvedScope: "HP Preview", configuration: expected,
      safety: "Draft journeys/sequences; disabled rules; no recipients or sending jobs copied" }));
    await client.query("ROLLBACK");
  } else {
    await catalog("intent_product_categories", "categories", data.categories, () => ({}));
    await catalog("intent_product_subcategories", "subcategories", data.subcategories,
      row => ({ category_id: required("categories", row.category_id) }));
    await catalog("intent_products", "products", data.products,
      row => ({ category_id: required("categories", row.category_id), subcategory_id: required("subcategories", row.subcategory_id) }));
    for (const j of data.journeys) maps.journeys.set(j.id, await insert("journeys", j,
      { slug: slugMap.get(j.slug), status: "draft", client_id: owner, tenant_id: tenant }));
    for (const t of data.templates) maps.templates.set(t.id, await insert("email_templates", t, { tenant_id: tenant }));
    for (const s of data.sequences) maps.sequences.set(s.id, await insert("email_sequences", s, {
      status: "draft", play_id: null, client_id: owner, journey_id: required("journeys", s.journey_id),
      trigger_type: "MANUAL", trigger_config: {}, nodes_json: {},
      sender_email: null, sender_name: null, smtp_account_id: null, tenant_id: tenant,
    }));
    for (const f of data.forms) maps.forms.set(f.id, await insert("journey_forms", f, {
      tenant_id: tenant, config: { ...rewrite(f.config), notifyOnSubmit: false,
        confirmationEmail: { ...f.config.confirmationEmail, enabled: false },
        onSubmit: { ...rewrite(f.config.onSubmit), enrollSequenceId: null } },
    }));
    for (const p of data.pages) {
      if (p.banner_id != null) throw new Error("Unexpected banner dependency");
      // Insert pages before remapping page-to-page references in content.
      maps.pages.set(p.id, await insert("journey_pages", p, {
        journey_id: required("journeys", p.journey_id), form_id: required("forms", p.form_id),
        banner_id: null, view_count: 0, content: null,
      }));
    }
    for (const p of data.pages) {
      let content = p.content;
      if (p.page_type === "blocks" && content) content = JSON.stringify(rewrite(JSON.parse(content)));
      else content = rewrite(content);
      await client.query("UPDATE journey_pages SET content=$1 WHERE id=$2", [content, required("pages", p.id)]);
    }
    for (const t of data.templates) await client.query(`UPDATE email_templates SET body_html=$1,body_text=$2,blocks_json=$3 WHERE id=$4`,
      [rewrite(t.body_html), rewrite(t.body_text), t.blocks_json == null ? null : JSON.stringify(rewrite(t.blocks_json)), required("templates", t.id)]);
    for (const s of data.sequences) await client.query("UPDATE email_sequences SET nodes_json=$1 WHERE id=$2",
      [JSON.stringify(rewrite(s.nodes_json)), required("sequences", s.id)]);
    for (const step of data.steps) maps.steps.set(step.id, await insert("sequence_steps", step, {
      sequence_id: required("sequences", step.sequence_id), config: rewrite(step.config),
      condition_config: rewrite(step.condition_config), true_next_step_id: null, false_next_step_id: null,
    }));
    for (const step of data.steps) await client.query(`UPDATE sequence_steps SET true_next_step_id=$1,false_next_step_id=$2 WHERE id=$3`,
      [required("steps", step.true_next_step_id), required("steps", step.false_next_step_id), required("steps", step.id)]);
    for (const r of data.rules) maps.rules.set(r.id, await insert("intent_inbound_routing_rules", r, {
      tenant_id: tenant, client_id: owner, enabled: false, created_by: null,
      name: r.classification === "warm" ? r.name.replace(/ · warm$/i, " · Hot & Warm") : r.name,
      classification: r.classification === "warm" ? "all" : r.classification,
      journey_id: required("journeys", r.journey_id), sequence_id: required("sequences", r.sequence_id),
      product_id: required("products", r.product_id), category_id: required("categories", r.category_id),
    }));
    const after = await client.query(`SELECT
      (SELECT count(*)::int FROM sequence_enrollments) AS enrollments,
      (SELECT count(*)::int FROM journey_contacts) AS journey_contacts,
      (SELECT count(*)::int FROM intent_inbound_submissions) AS submissions`);
    if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) throw new Error("Recipient state changed during restoration; rolling back");
    const unsafe = await client.query(`SELECT id FROM intent_inbound_routing_rules
      WHERE id=ANY($1::int[]) AND enabled=true`, [[...maps.rules.values()]]);
    if (unsafe.rowCount) throw new Error("Copied rule unexpectedly enabled");
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, maps: Object.fromEntries(Object.entries(maps).map(([k,v]) => [k, Object.fromEntries(v)])),
      recipientStateUnchanged: true, copiedRulesEnabled: false, copiedSequenceStatus: "draft" }));
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
