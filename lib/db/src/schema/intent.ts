import { pgTable, serial, integer, text, timestamp, boolean, jsonb, numeric, uniqueIndex, index, check, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Additive, isolated storage for the always-on intent engine. */
export const intentSignalTypesTable = pgTable("intent_signal_types", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(),
  key: text("key").notNull(), label: text("label").notNull(), category: text("category").notNull().default("signal"),
  maxPoints: integer("max_points").notNull(), halfLifeDays: integer("half_life_days").notNull(),
  active: boolean("active").notNull().default(true), options: jsonb("options").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_signal_types_tenant_key_uq").on(t.tenantId, t.key)]);

export const intentQuestionnaireSettingsTable = pgTable("intent_questionnaire_settings", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(),
  dimension: text("dimension").notNull(), label: text("label").notNull(),
  maxPoints: integer("max_points").notNull(), rules: jsonb("rules").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_questionnaire_settings_tenant_dimension_uq").on(t.tenantId, t.dimension),
  check("intent_questionnaire_settings_max_points_ck", sql`${t.maxPoints} BETWEEN 0 AND 100`),
]);

export const intentTiersTable = pgTable("intent_tiers", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), key: text("key").notNull(), label: text("label").notNull(),
  minScore: integer("min_score").notNull(), color: text("color").notNull(), sortOrder: integer("sort_order").notNull().default(0), active: boolean("active").notNull().default(true), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_tiers_tenant_key_uq").on(t.tenantId, t.key), index("intent_tiers_tenant_score_idx").on(t.tenantId, t.minScore)]);

export const intentSignalsTable = pgTable("intent_signals", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"),
  productId: integer("product_id"), signalTypeId: integer("signal_type_id").notNull(), accountId: integer("account_id"), contactId: integer("contact_id"),
  source: text("source").notNull(), externalId: text("external_id"), rowHash: text("row_hash"), summary: text("summary"),
  strength: integer("strength").notNull().default(50), vertical: text("vertical"), function: text("function"), expiresAt: timestamp("expires_at", { withTimezone: true }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(), payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("intent_signals_tenant_entity_idx").on(t.tenantId, t.accountId, t.contactId, t.occurredAt),
  index("intent_signals_tenant_type_time_idx").on(t.tenantId, t.signalTypeId, t.occurredAt),
  index("intent_signals_tenant_entity_time_idx").on(t.tenantId, t.contactId, t.occurredAt),
   index("intent_signals_tenant_product_entity_idx").on(t.tenantId, t.productId, t.accountId, t.occurredAt),
  uniqueIndex("intent_signals_external_uq").on(t.tenantId, t.source, t.externalId).where(sql`external_id IS NOT NULL`),
  uniqueIndex("intent_signals_row_hash_uq").on(t.tenantId, t.source, t.rowHash).where(sql`row_hash IS NOT NULL`),
]);

export const intentEntityScoresTable = pgTable("intent_entity_scores", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), accountId: integer("account_id"), contactId: integer("contact_id"),
  score: integer("score").notNull().default(0), previousScore: integer("previous_score").notNull().default(0), tier: text("tier").notNull(), trend: text("trend").notNull().default("stable"), trendDelta: integer("trend_delta").notNull().default(0),
  lastSignalAt: timestamp("last_signal_at", { withTimezone: true }), contributions: jsonb("contributions").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_entity_scores_account_uq").on(t.tenantId, t.accountId).where(sql`account_id IS NOT NULL`),
  uniqueIndex("intent_entity_scores_contact_uq").on(t.tenantId, t.contactId).where(sql`contact_id IS NOT NULL`),
  index("intent_entity_scores_tenant_tier_idx").on(t.tenantId, t.tier, t.score),
]);

export const intentScoreHistoryTable = pgTable("intent_score_history", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), entityScoreId: integer("entity_score_id").notNull(),
  score: integer("score").notNull(), tier: text("tier").notNull(), contributions: jsonb("contributions").notNull().default([]),
  source: text("source").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("intent_score_history_tenant_entity_idx").on(t.tenantId, t.entityScoreId, t.createdAt)]);

export const intentRecommendationsTable = pgTable("intent_recommendations", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), accountId: integer("account_id"), contactId: integer("contact_id"),
  tier: text("tier").notNull(), playType: text("play_type").notNull(), status: text("status").notNull().default("pending"), title: text("title").notNull(), summary: text("summary").notNull().default(""),
  options: jsonb("options").notNull().default([]), evidence: jsonb("evidence").notNull().default({}), note: text("note"), error: text("error"),
  generationStatus: text("generation_status").notNull().default("deterministic"), generatedAt: timestamp("generated_at", {withTimezone:true}), resolvedAt: timestamp("resolved_at", {withTimezone:true}), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("intent_recommendations_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
  index("intent_recommendations_tenant_status_time_idx").on(t.tenantId, t.status, t.updatedAt),
  uniqueIndex("intent_recommendations_pending_account_uq").on(t.tenantId, t.accountId).where(sql`account_id IS NOT NULL AND status='pending'`),
  uniqueIndex("intent_recommendations_pending_contact_uq").on(t.tenantId, t.contactId).where(sql`contact_id IS NOT NULL AND status='pending'`),
]);

export const intentRecommendationOutcomesTable = pgTable("intent_recommendation_outcomes", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), recommendationId: integer("recommendation_id").notNull(),
  status: text("status").notNull(), note: text("note"), actorId: integer("actor_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("intent_recommendation_outcomes_tenant_rec_idx").on(t.tenantId, t.recommendationId)]);

export const intentImportRunsTable = pgTable("intent_import_runs", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"), kind: text("kind").notNull(),
  productId: integer("product_id"), audienceId: integer("audience_id"),
  idempotencyKey: text("idempotency_key").notNull(), fileName: text("file_name"), fileHash: text("file_hash").notNull(),
  status: text("status").notNull().default("completed"), totalRows: integer("total_rows").notNull().default(0), insertedRows: integer("inserted_rows").notNull().default(0), skippedRows: integer("skipped_rows").notNull().default(0), failedRows: integer("failed_rows").notNull().default(0), unmatchedRows: integer("unmatched_rows").notNull().default(0),
  summary: jsonb("summary").notNull().default({}), errors: jsonb("errors").notNull().default([]), createdBy: integer("created_by"), completedAt: timestamp("completed_at",{withTimezone:true}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_import_runs_tenant_key_uq").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("intent_import_runs_tenant_hash_uq").on(t.tenantId, t.kind, sql`COALESCE(${t.clientId},0)`, sql`COALESCE(${t.productId},0)`, sql`COALESCE(${t.audienceId},0)`, t.fileHash),
]);

/** Tenant-owned catalog used to scope imported and manually created intent signals. */
export const intentProductCategoriesTable = pgTable("intent_product_categories", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_product_categories_tenant_name_uq").on(t.tenantId, t.name)]);

export const intentProductSubcategoriesTable = pgTable("intent_product_subcategories", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), categoryId: integer("category_id").notNull(), name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_product_subcategories_tenant_category_name_uq").on(t.tenantId, t.categoryId, t.name)]);

export const intentProductsTable = pgTable("intent_products", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), categoryId: integer("category_id").notNull(), subcategoryId: integer("subcategory_id"),
  name: text("name").notNull(), active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_products_tenant_name_uq").on(t.tenantId, t.name), index("intent_products_tenant_category_idx").on(t.tenantId, t.categoryId, t.subcategoryId)]);

export const intentProductPricingTable = pgTable("intent_product_pricing", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  productId: integer("product_id").notNull(),
  averageUnitPrice: numeric("average_unit_price", { precision: 14, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_product_pricing_tenant_product_uq").on(t.tenantId, t.productId),
  check("intent_product_pricing_nonnegative_ck", sql`${t.averageUnitPrice} >= 0`),
]);

export const intentAudiencesTable = pgTable("intent_audiences", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"), name: text("name").notNull(), description: text("description"),
  createdBy: integer("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_audiences_tenant_name_uq").on(t.tenantId, t.name), index("intent_audiences_tenant_client_idx").on(t.tenantId, t.clientId)]);

export const intentAudienceCompaniesTable = pgTable("intent_audience_companies", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), audienceId: integer("audience_id").notNull(), companyId: integer("company_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_audience_companies_membership_uq").on(t.tenantId, t.audienceId, t.companyId), index("intent_audience_companies_company_idx").on(t.tenantId, t.companyId)]);

export const intentMonitoringConfigsTable = pgTable("intent_monitoring_configs", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"),
  name: text("name").notNull().default("Monitoring schedule"),
  enabled: boolean("enabled").notNull().default(false), dailyLimit: integer("daily_limit").notNull().default(500),
  lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }), lastScheduledCount: integer("last_scheduled_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("intent_monitoring_configs_tenant_enabled_idx").on(t.tenantId,t.enabled),
  check("intent_monitoring_configs_daily_limit_ck", sql`${t.dailyLimit} in (100,200,400,500,1000)`),
]);

export const intentMonitoringAudiencesTable = pgTable("intent_monitoring_audiences", {
  tenantId: integer("tenant_id").notNull(), configId: integer("config_id").notNull(), audienceId: integer("audience_id").notNull(),
}, t => [
  primaryKey({ columns: [t.tenantId, t.configId, t.audienceId], name: "intent_monitoring_audiences_pk" }),
  foreignKey({ columns:[t.configId], foreignColumns:[intentMonitoringConfigsTable.id], name:"intent_monitoring_audiences_config_fk" }).onDelete("cascade"),
  index("intent_monitoring_audiences_lookup_idx").on(t.tenantId, t.audienceId),
]);

export const intentMonitoringSegmentsTable = pgTable("intent_monitoring_segments", {
  tenantId: integer("tenant_id").notNull(), configId: integer("config_id").notNull(), segmentId: integer("segment_id").notNull(),
}, t => [
  primaryKey({ columns: [t.tenantId, t.configId, t.segmentId], name: "intent_monitoring_segments_pk" }),
  foreignKey({ columns:[t.configId], foreignColumns:[intentMonitoringConfigsTable.id], name:"intent_monitoring_segments_config_fk" }).onDelete("cascade"),
  index("intent_monitoring_segments_lookup_idx").on(t.tenantId, t.segmentId),
]);

export const intentMonitoringCategoriesTable = pgTable("intent_monitoring_categories", {
  tenantId: integer("tenant_id").notNull(), configId: integer("config_id").notNull(), categoryId: integer("category_id").notNull(),
}, t => [
  primaryKey({ columns: [t.tenantId, t.configId, t.categoryId], name: "intent_monitoring_categories_pk" }),
  foreignKey({ columns:[t.configId], foreignColumns:[intentMonitoringConfigsTable.id], name:"intent_monitoring_categories_config_fk" }).onDelete("cascade"),
  index("intent_monitoring_categories_lookup_idx").on(t.tenantId, t.categoryId),
]);

export const intentMonitoringAccountsTable = pgTable("intent_monitoring_accounts", {
  tenantId: integer("tenant_id").notNull(), configId: integer("config_id").notNull(), companyId: integer("company_id").notNull(),
}, t => [
  primaryKey({ columns: [t.tenantId,t.configId,t.companyId], name: "intent_monitoring_accounts_pk" }),
  foreignKey({ columns:[t.configId], foreignColumns:[intentMonitoringConfigsTable.id], name:"intent_monitoring_accounts_config_fk" }).onDelete("cascade"),
  index("intent_monitoring_accounts_lookup_idx").on(t.tenantId,t.companyId),
]);

/** Google Drive folders that supply questionnaire and event-feedback responses. */
export const intentInboundSourcesTable = pgTable("intent_inbound_sources", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  name: text("name").notNull().default("Inbound forms"), folderUrl: text("folder_url").notNull(), folderId: text("folder_id").notNull(),
  formType: text("form_type").notNull().default("lead_form"),
  enabled: boolean("enabled").notNull().default(true), lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  fieldMappings: jsonb("field_mappings").notNull().default({}),
  lastSyncStatus: text("last_sync_status").notNull().default("never"), lastSyncSummary: jsonb("last_sync_summary").notNull().default({}),
  createdBy: integer("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_inbound_sources_tenant_folder_uq").on(t.tenantId, t.folderId),
  index("intent_inbound_sources_tenant_enabled_idx").on(t.tenantId, t.enabled),
  check("intent_inbound_sources_form_type_ck", sql`${t.formType} in ('lead_form','event_feedback')`),
]);

/** Admin-owned rules that route inbound affinity cohorts into an optional journey and email sequence. */
export const intentInboundCategoryRulesTable = pgTable("intent_inbound_category_rules", {
  tenantId: integer("tenant_id").primaryKey(),
  rules: jsonb("rules").notNull().default([]),
  useBuiltin: boolean("use_builtin").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const intentInboundRoutingRulesTable = pgTable("intent_inbound_routing_rules", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  name: text("name").notNull(), matchType: text("match_type").notNull(), classification: text("classification").notNull().default("warm"),
  productId: integer("product_id"), categoryId: integer("category_id"),
  inboundProductName: text("inbound_product_name"), inboundCategoryName: text("inbound_category_name"),
  keywords: jsonb("keywords").notNull().default([]),
  journeyId: integer("journey_id"), sequenceId: integer("sequence_id").notNull(),
  priority: integer("priority").notNull().default(100), enabled: boolean("enabled").notNull().default(true),
  createdBy: integer("created_by"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("intent_inbound_routing_rules_lookup_idx").on(t.tenantId, t.clientId, t.enabled, t.priority),
  check("intent_inbound_routing_rules_match_type_ck", sql`${t.matchType} in ('product','category','fallback')`),
  check("intent_inbound_routing_rules_classification_ck", sql`${t.classification} in ('hot','warm','all')`),
]);

/** Canonical, reviewable rows imported from inbound forms. Never used by external monitoring. */
export const intentInboundSubmissionsTable = pgTable("intent_inbound_submissions", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), sourceId: integer("source_id"),
  clientId: integer("client_id").notNull(), accountId: integer("account_id").notNull(), contactId: integer("contact_id"),
  driveFileId: text("drive_file_id").notNull(), driveModifiedAt: timestamp("drive_modified_at", { withTimezone: true }),
  rowKey: text("row_key").notNull(), fileName: text("file_name").notNull(), formType: text("form_type").notNull().default("questionnaire"),
  classification: text("classification").notNull(), classificationReason: text("classification_reason").notNull(),
  explicitInterest: boolean("explicit_interest").notNull().default(false), requestedDemo: boolean("requested_demo").notNull().default(false),
  purchaseTimeframeMonths: integer("purchase_timeframe_months"), isDecisionMaker: boolean("is_decision_maker").notNull().default(false),
  feedback: text("feedback"), productInterest: text("product_interest"), submittedAt: timestamp("submitted_at", { withTimezone: true }),
  eventFeedback: jsonb("event_feedback").notNull().default({}),
  affinityReviews: jsonb("affinity_reviews").notNull().default({}),
  identityReview: text("identity_review"),
  identityReviewedBy: integer("identity_reviewed_by"),
  identityReviewedAt: timestamp("identity_reviewed_at", { withTimezone: true }),
  reviewedEmail: text("reviewed_email"),
  reviewedSourceAccountId: integer("reviewed_source_account_id"),
  reviewedSourceContactId: integer("reviewed_source_contact_id"),
  routedRuleId: integer("routed_rule_id"), routingStatus: text("routing_status").notNull().default("pending"),
  routingError: text("routing_error"), routedAt: timestamp("routed_at", { withTimezone: true }),
  rawFields: jsonb("raw_fields").notNull().default({}), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_inbound_submissions_row_uq").on(t.tenantId, t.sourceId, t.driveFileId, t.rowKey),
  index("intent_inbound_submissions_account_idx").on(t.tenantId, t.accountId, t.classification),
  index("intent_inbound_submissions_contact_idx").on(t.tenantId, t.contactId),
  index("intent_inbound_submissions_routing_idx").on(t.tenantId, t.routingStatus, t.classification),
  check("intent_inbound_submissions_classification_hot_warm_cold_check", sql`${t.classification} in ('hot','warm','cold')`),
  check("intent_inbound_submissions_identity_review_check", sql`${t.identityReview} IS NULL OR ${t.identityReview} in ('keep','relink')`),
]);

/** Non-personal source keys prevent deleted Drive rows from reappearing on sync. */
export const intentInboundDeletedRowsTable = pgTable("intent_inbound_deleted_rows", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  sourceId: integer("source_id").notNull(),
  driveFileId: text("drive_file_id").notNull(),
  rowKey: text("row_key").notNull(),
  identityHash: text("identity_hash"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_inbound_deleted_rows_key_uq").on(t.tenantId, t.sourceId, t.driveFileId, t.rowKey),
  index("intent_inbound_deleted_rows_identity_idx").on(t.tenantId, t.sourceId, t.driveFileId, t.identityHash),
]);

/** A respondent's explicit destination for one selected interest on an inbound response. */
export const intentInboundManualRoutesTable = pgTable("intent_inbound_manual_routes", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(),
  submissionId: integer("submission_id").notNull(), contactId: integer("contact_id").notNull(),
  selection: text("selection").notNull(), journeyId: integer("journey_id").notNull(),
  sequenceId: integer("sequence_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_inbound_manual_routes_submission_uq").on(t.tenantId,t.submissionId),
  index("intent_inbound_manual_routes_contact_idx").on(t.tenantId,t.contactId),
]);

export const intentRecomputeQueueTable = pgTable("intent_recompute_queue", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), accountId: integer("account_id"), contactId: integer("contact_id"),
  source: text("source").notNull(), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(), claimedAt: timestamp("claimed_at", { withTimezone: true }), error: text("error"), maxAttempts: integer("max_attempts").notNull().default(5), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [
  index("intent_recompute_queue_claim_idx").on(t.tenantId, t.status, t.availableAt),
  uniqueIndex("intent_recompute_queue_active_account_uq").on(t.tenantId, t.accountId).where(sql`account_id IS NOT NULL AND status IN ('pending','claimed')`),
  uniqueIndex("intent_recompute_queue_active_contact_uq").on(t.tenantId, t.contactId).where(sql`contact_id IS NOT NULL AND status IN ('pending','claimed')`),
]);

/** Verifiable, provider-neutral account research.  These records are never used by global CRM scoring. */
export const intentResearchRunsTable = pgTable("intent_research_runs", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"), audienceId: integer("audience_id"),
  provider: text("provider").notNull().default("manual"), status: text("status").notNull().default("completed"),
  idempotencyKey: text("idempotency_key").notNull(), attempts: integer("attempts").notNull().default(1), retryOfId: integer("retry_of_id"),
  requestedBy: integer("requested_by"), requestCount: integer("request_count").notNull().default(0),
  confirmedRequestCount: integer("confirmed_request_count").notNull().default(0), requestLimit: integer("request_limit"),
  summary: jsonb("summary").notNull().default({}), error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [uniqueIndex("intent_research_runs_tenant_key_uq").on(t.tenantId, t.idempotencyKey), index("intent_research_runs_tenant_status_idx").on(t.tenantId, t.status, t.startedAt)]);

export const intentResearchRunAccountsTable = pgTable("intent_research_run_accounts", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), runId: integer("run_id").notNull(), accountId: integer("account_id").notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  summary: jsonb("summary").notNull().default({}), error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("intent_research_run_accounts_tenant_run_account_uq").on(t.tenantId, t.runId, t.accountId),
  index("intent_research_run_accounts_claim_idx").on(t.tenantId, t.runId, t.status, t.createdAt),
  index("intent_research_run_accounts_account_status_idx").on(t.tenantId,t.accountId,t.status),
]);

export const intentEvidenceTable = pgTable("intent_evidence", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), signalId: integer("signal_id"), researchRunId: integer("research_run_id"), importRunId: integer("import_run_id"),
  accountId: integer("account_id"), contactId: integer("contact_id"), productId: integer("product_id"),
  evidenceKind: text("evidence_kind").notNull(), eventType: text("event_type"), eventFingerprint: text("event_fingerprint"),
  sourceUrl: text("source_url"), excerpt: text("excerpt"), provider: text("provider").notNull(), confidence: integer("confidence").notNull().default(50),
  context: jsonb("context").notNull().default({}), rawEvidence: jsonb("raw_evidence").notNull().default({}),
  reviewStatus: text("review_status").notNull().default("approved"), reviewedBy: integer("reviewed_by"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("intent_evidence_confidence_check", sql`${t.confidence} BETWEEN 0 AND 100`),
  uniqueIndex("intent_evidence_tenant_fingerprint_uq").on(t.tenantId, t.eventFingerprint).where(sql`event_fingerprint IS NOT NULL`),
  index("intent_evidence_tenant_account_product_idx").on(t.tenantId, t.accountId, t.productId, t.occurredAt),
  index("intent_evidence_tenant_signal_idx").on(t.tenantId, t.signalId),
  index("intent_evidence_tenant_import_run_idx").on(t.tenantId, t.importRunId),
  index("intent_evidence_tenant_review_idx").on(t.tenantId, t.reviewStatus, t.createdAt),
]);

// Server-issued proposals are not approvals. Applied rows retain the exact reviewed delta.
export const intentResearchCorrectionsTable = pgTable("intent_research_corrections", {
  id: text("id").primaryKey(), tenantId: integer("tenant_id").notNull(),
  accountId: integer("account_id").notNull(), evidenceId: integer("evidence_id").notNull(),
  sourceVersion: text("source_version").notNull(), proposal: jsonb("proposal").notNull(),
  status: text("status").notNull().default("proposed"),
  proposedBy: integer("proposed_by").notNull(), approvedBy: integer("approved_by"),
  reason: text("reason"), appliedDelta: jsonb("applied_delta"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, t => [
  check("intent_research_corrections_status_check", sql`${t.status} IN ('proposed','applied')`),
  index("intent_research_corrections_account_idx").on(t.tenantId, t.accountId, t.createdAt),
]);

export const intentContactDiscoveryRunsTable = pgTable("intent_contact_discovery_runs", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id"), audienceId: integer("audience_id"),
  provider: text("provider").notNull().default("manual"), criteria: jsonb("criteria").notNull().default({}), idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("preview"), attempts: integer("attempts").notNull().default(1), summary: jsonb("summary").notNull().default({}), error: text("error"),
  requestedBy: integer("requested_by"), completedAt: timestamp("completed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("intent_contact_discovery_runs_tenant_key_uq").on(t.tenantId, t.idempotencyKey), index("intent_discovery_runs_tenant_status_idx").on(t.tenantId, t.status, t.createdAt)]);

export const intentContactDiscoveryCandidatesTable = pgTable("intent_contact_discovery_candidates", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), runId: integer("run_id").notNull(), companyId: integer("company_id"),
  firstName: text("first_name"), lastName: text("last_name"), email: text("email"), phone: text("phone"), title: text("title"), function: text("function"), location: text("location"),
  sourceUrl: text("source_url"), provider: text("provider").notNull(), confidence: integer("confidence").notNull().default(50), rawEvidence: jsonb("raw_evidence").notNull().default({}),
  matchStatus: text("match_status").notNull().default("pending_review"), canonicalContactId: integer("canonical_contact_id"), reviewedBy: integer("reviewed_by"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("intent_contact_discovery_candidates_confidence_check", sql`${t.confidence} BETWEEN 0 AND 100`),
  index("intent_discovery_candidates_tenant_run_idx").on(t.tenantId, t.runId, t.matchStatus),
]);