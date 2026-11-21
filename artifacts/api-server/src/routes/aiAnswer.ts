import { Router } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { answerPlanSchema, interpretAnswerQuestion, simpleEngagedAccountPlan, accountPlanRestrictions } from "../lib/aiAnswerPlan";
import { queryAnswerPeople, regionLocations } from "../lib/aiAnswerQuery";
import { queryAnswerAccounts } from "../lib/aiAnswerAccounts";

const router = Router();
router.use("/ai-answer", requireAuth);
const input = z.object({
  clientId: z.number().int().positive(),
  question: z.string().trim().min(5).max(2000),
  page: z.number().int().min(1).max(10000).default(1),
  plan: answerPlanSchema.optional(),
}).strict();
const active = new Map<number, number>();
router.post("/ai-answer", async (req, res) => {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a client and enter a question (5–2,000 characters)." }); return; }
  const tenantId = Number((req.user as any).tenantId);
  const { clientId, question, page } = parsed.data;
  if ((active.get(tenantId) ?? 0) >= 2) {
    res.status(429).json({ error: "Two AI Answer searches are already running. Please wait and try again." }); return;
  }
  active.set(tenantId, (active.get(tenantId) ?? 0) + 1);
  try {
    if (!(await pool.query("SELECT id FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, clientId])).rowCount) {
      res.status(404).json({ error: "Client not found." }); return;
    }
    const plan = parsed.data.plan ?? simpleEngagedAccountPlan(question) ?? await interpretAnswerQuestion(question, { tenantId, clientId });
    plan.unsupported = [...plan.unsupported, ...accountPlanRestrictions(plan)].slice(0, 10);
    const accounts = plan.mode === "accounts" || plan.mode === "account-count";
    if (plan.unsupported.length) {
      res.json({ question, plan, total: 0, people: [], accounts: [], page: 1, pageSize: 25,
        answer: "Please clarify or revise the question before searching.", clarification: plan.unsupported,
        notes: [], regionDefinitions: regionLocations }); return;
    }
    const result = await (accounts ? queryAnswerAccounts : queryAnswerPeople)(tenantId, clientId, plan, page);
    const noun = accounts ? (result.total === 1 ? "account" : "accounts") : (result.total === 1 ? "person" : "people");
    res.json({ question, plan, ...result,
      answer: result.total === 0 ? `No matching ${accounts ? "accounts" : "people"} found in the recorded data.` :
        `${result.total.toLocaleString("en-IN")} matching ${noun} found in the selected client.`,
      clarification: [],
      notes: accounts ? [
        "Each legal CRM company is counted once, not each contact or parent group. Only the selected client's owned accounts are searched.",
        "General engagement includes recorded attendance, lead/interest/digital/content records, questionnaire and journey-form responses, and canonically attributed human visits, clicks, downloads and completed calls. Account-level records do not require a contact.",
        "Invitations, email sends, email opens, public research and bot-only activity do not qualify. A response without positive product interest can still be general engagement.",
        "Product-specific searches require matching recorded product evidence; unrelated or untagged activity is never inferred as interest in that product.",
        "Matching records are distinct source references, not deduplicated real-world interactions across imports. Up to five matching evidence records are shown per account. All matching accounts are counted; results are paginated.",
        "This is a read-only search; it never enrolls contacts or sends messages.",
      ] : ["Recorded contact location and function only; missing fields are not inferred from title or company headquarters.",
        "Product interest requires evidence linked to this person, not an account-level product fit, public news, invitation or email open.",
        "Product evidence covers questionnaires, configured journey-form product answers, product-specific lead/interest/digital/content records and canonically attributed human activity on product-tagged pages. Untagged activity is never inferred as product interest.",
        "Without a product filter, general engagement also includes attributable questionnaire/form responses, recorded attendance and untagged visits/clicks/downloads. Invitations, sends, opens and bot-only activity do not qualify.",
        "Current intent scores are global contact scores, not product-specific lead qualification. DNC contacts are labelled; this search never sends messages.",
        "Up to five recent matching evidence records are shown per person. All matches are counted; results are paginated, not sampled."],
      regionDefinitions: regionLocations });
  } catch (err: any) {
    req.log?.warn({ code: err.code, name: err.name }, "AI Answer failed");
    res.status(err.code === "57014" ? 408 : 502).json({
      error: err.code === "57014" ? "This search took too long. Add more filters and retry." :
        "AI Answer could not complete this search. Please retry or use a more specific question.",
    });
  } finally {
    const remaining = (active.get(tenantId) ?? 1) - 1;
    if (remaining) active.set(tenantId, remaining); else active.delete(tenantId);
  }
});
export default router;
