import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { journeyFormsTable } from "./journey-forms";
import { contactsTable } from "./contacts";
import { journeysTable } from "./journeys";

export const formSubmissionsTable = pgTable(
  "form_submissions",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    formId: integer("form_id").references(() => journeyFormsTable.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
    journeyId: integer("journey_id").references(() => journeysTable.id, { onDelete: "set null" }),
    pageId: integer("page_id"),
    visitorToken: text("visitor_token"),
    fieldValues: jsonb("field_values").notNull().default({}),
    actionType: text("action_type"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_form_submissions_tenant").on(t.tenantId),
    index("idx_form_submissions_form").on(t.formId),
    index("idx_form_submissions_contact").on(t.contactId),
  ],
);

export const insertFormSubmissionSchema = createInsertSchema(formSubmissionsTable).omit({ id: true, submittedAt: true });
export type InsertFormSubmission = z.infer<typeof insertFormSubmissionSchema>;
export type FormSubmission = typeof formSubmissionsTable.$inferSelect;
