import type { HpRoutingContact } from "@workspace/api-client-react";

export interface BulkRoutingResult { contactId: number; name: string; journey: string; sequence: string }

/** Separate per-contact outcomes, including partial success. Retrying never requests a restart. */
export async function routeHpContacts(
  clientId: number, contacts: HpRoutingContact[], journeyId: number, sequenceId?: number, product?: string,
  send = async (body: unknown) => {
    const response = await fetch(`${import.meta.env.BASE_URL}api/analytics/hp-bi/manage-account`, {
      method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Routing failed");
    return result;
  },
) {
  const results: BulkRoutingResult[] = [];
  for (const c of [...new Map(contacts.map(c => [c.id,c])).values()]) {
    let journey = "Not routed", sequence = sequenceId ? "Not attempted" : "Not selected";
    const base = { clientId,accountId:c.accountId,contactId:c.id,journeyId,product };
    try {
      if (!c.eligible) throw new Error(c.reason || "Contact is not eligible");
      const added = await send({...base,action:"add-journey"});
      if (added.dncSkipped) throw new Error("Do not contact — skipped");
      if (typeof added.added !== "number") throw new Error("Journey assignment was not confirmed");
      journey = added.added ? "Added" : "Already assigned";
      if (sequenceId) {
        try {
          const enrolled = await send({...base,action:"enroll-sequence",sequenceId});
          sequence = enrolled.enrolled ? "Enrolled" : enrolled.existingStatus
            ? `Existing: ${enrolled.existingStatus} (not restarted)` : enrolled.alreadyActive
              ? "Already active" : enrolled.skippedCompleted ? "Completed (not restarted)"
                : "Not enrolled — check eligibility";
        } catch (err) { sequence = `Failed: ${(err as Error).message}`; }
      }
    } catch (err) { journey = `Failed: ${(err as Error).message}`; }
    results.push({contactId:c.id,name:c.name,journey,sequence});
  }
  return results;
}
