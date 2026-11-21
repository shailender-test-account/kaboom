import { pgTable, serial, integer, text, boolean, jsonb, timestamp, numeric, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { companiesTable, contactsTable } from "./contacts";

export const hpAccountProfilesTable = pgTable("hp_account_profiles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  hpId: text("hp_id"),
  deployment: text("deployment"), gtm: text("gtm"), group: text("account_group"),
  stateUt: text("state_ut"), zone: text("zone"), parentSub: text("parent_sub"),
  topId: text("top_id"), topName: text("top_name"), midId: text("mid_id"), midName: text("mid_name"),
  actSt: text("act_st"), stName: text("st_name"), partialSt: text("partial_st"), partialName: text("partial_name"),
  orgId: text("org_id"), opsi: text("opsi"), legalName: text("legal_name"), city: text("city"), state: text("state"),
  relationshipLink: text("relationship_link"), industryVertical: text("industry_vertical"), industrySegment: text("industry_segment"),
  hpiSegment: text("hpi_segment"), eCat: text("e_cat"), empSize: text("emp_size"),
  psTamK: text("ps_tam_k"), prtTamK: text("prt_tam_k"), psRad: text("ps_rad"), prtRad: text("prt_rad"),
  rtmPs: text("rtm_ps"), psPartners: text("ps_partners"), rtmPrint: text("rtm_print"), printPartners: text("print_partners"),
  eamEmail: text("eam_email"), pamEmail: text("pam_email"), rmEmail: text("rm_email"), isrEmail: text("isr_email"),
  zmEmail: text("zm_email"), polyAmEmail: text("poly_am_email"), polyMgrEmail: text("poly_mgr_email"),
  parentKey: text("parent_key").notNull(), parentName: text("parent_name").notNull(),
  dimensions: jsonb("dimensions").notNull().default({}), variants: jsonb("variants").notNull().default([]),
  aliases: text("aliases").array().notNull().default([]),
  isNew: boolean("is_new").notNull().default(false), provenance: text("provenance").notNull(),
  abmClassification: text("abm_classification"), top200: boolean("top_200").notNull().default(false),
  globalAccount: boolean("global_account"), profiled: boolean("profiled"),
  buyingBehavior: text("buying_behavior"), propensity: text("propensity"),
  buyerCategories: text("buyer_categories").array().notNull().default([]),
  whitespaceCategories: text("whitespace_categories").array().notNull().default([]),
  edits: jsonb("edits").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("hp_profile_company").on(t.tenantId, t.clientId, t.companyId),
  uniqueIndex("hp_profile_stable_id").on(t.tenantId, t.clientId, t.hpId),
  index("hp_profile_scope").on(t.tenantId, t.clientId, t.parentKey),
]);
export const hpBiRecordsTable = pgTable("hp_bi_records", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  accountId: integer("account_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  category: text("category"), product: text("product"), horizonMonths: numeric("horizon_months"),
  orderValue: numeric("order_value"), currency: text("currency"), status: text("status"),
  source: text("source").notNull(), sourceName: text("source_name"), sourceKey: text("source_key").notNull(),
  externalEventId: text("external_event_id"), lineage: jsonb("lineage").notNull().default({}),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("hp_record_source").on(t.tenantId, t.clientId, t.sourceKey),
  index("hp_record_period").on(t.tenantId, t.clientId, t.occurredAt, t.accountId),
]);
export const hpBiImportsTable = pgTable("hp_bi_imports", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  fileName: text("file_name").notNull(), fileHash: text("file_hash").notNull(), kind: text("kind").notNull(),
  rows: integer("rows").notNull(), accounts: integer("accounts").notNull(), result: jsonb("result").notNull(),
  importedBy: integer("imported_by"), importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});
export const hpBiMatchesTable = pgTable("hp_bi_matches", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  sourceKey: text("source_key").notNull(), reason: text("reason").notNull(), payload: jsonb("payload").notNull(),
  resolvedAccountId: integer("resolved_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("hp_match_key").on(t.tenantId, t.clientId, t.sourceKey)]);
export const hpBiContactsTable = pgTable("hp_bi_contacts", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  isNew: boolean("is_new").notNull(), source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("hp_contact_provenance").on(t.tenantId, t.clientId, t.contactId)]);
export const insertHpAccountProfileSchema = createInsertSchema(hpAccountProfilesTable).omit({ id: true });
export const insertHpBiRecordSchema = createInsertSchema(hpBiRecordsTable).omit({ id: true });
