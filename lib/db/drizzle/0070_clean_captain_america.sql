CREATE INDEX "sales_access_audit_tenant_page_idx" ON "sales_access_audit" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_access_audit_actor_page_idx" ON "sales_access_audit" USING btree ("tenant_id","actor_id","id");--> statement-breakpoint
CREATE INDEX "sales_access_audit_date_idx" ON "sales_access_audit" USING btree ("tenant_id","recorded_at");