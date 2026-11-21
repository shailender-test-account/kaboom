/**
 * Local transcript analyser — no external API required.
 * Detects topics, objections, and positive signals from raw call transcript text,
 * then builds a plain-English summary and ordered list of next steps.
 */

export function analyseTranscript(
  text: string,
  outcome: string | null,
  durationSeconds: number | null,
  contactName: string,
  companyName: string | null,
): { aiSummary: string; aiNextSteps: string } {
  const t = text.toLowerCase();

  const topics: string[] = [];
  if (/\bpric(e|ing|ed)\b|\bcost\b|\bbudget\b|\bafford/.test(t))                topics.push("pricing");
  if (/\bdemo\b|\bwalkthrough\b|\bwalk.?through\b|\bshow you\b/.test(t))         topics.push("a demo");
  if (/\btrial\b|\bpilot\b|\bproof.of.concept\b|\bpoc\b/.test(t))               topics.push("a trial or pilot");
  if (/\btimeline\b|\bwhen.{0,20}(start|launch|go.?live)\b|\bquarter\b/.test(t)) topics.push("timeline");
  if (/\bintegrat(e|ion|ions)\b|\bapi\b|\bconnect(or|s)?\b/.test(t))            topics.push("integrations");
  if (/\bcompetitor\b|\balternative\b|\bvs\b|\bcompare\b|\bother solution/.test(t)) topics.push("competing solutions");
  if (/\bteam\b|\bstakeholder\b|\bdecision.maker\b|\bmanager\b/.test(t))        topics.push("team / stakeholders");
  if (/\broi\b|\breturn on investment\b|\bvalue\b|\bbenefit/.test(t))            topics.push("ROI / business value");
  if (/\bsecurity\b|\bcomplian(ce|t)\b|\bgdpr\b|\bsoc.?2\b/.test(t))            topics.push("security & compliance");

  const objections: string[] = [];
  if (/\bnot (the )?(right|good) time\b|\btoo busy\b|\bnot now\b|\bnot (really )?interested\b/.test(t)) objections.push("timing");
  if (/\btoo expensive\b|\bover budget\b|\bcan't afford\b|\bno budget\b/.test(t))  objections.push("budget");
  if (/\balready (have|using|use)\b|\bcurrent(ly)? use\b/.test(t))                 objections.push("existing solution");
  if (/\bneed to (check|ask|discuss|talk to|speak to|run it by)\b/.test(t))        objections.push("needs sign-off");
  if (/\bnot sure\b|\buncertain\b|\bnot convinced\b|\bdon't know\b/.test(t))       objections.push("uncertainty");

  const positive: string[] = [];
  if (/\bsend (me|us|over)\b|\bforward (me|us|the)\b/.test(t))              positive.push("asked for follow-up materials");
  if (/\bbook(ing)?\b|\bschedul(e|ing)\b|\bset up (a|the)\b/.test(t))       positive.push("open to scheduling a follow-up");
  if (/\bcall (me|us)? back\b|\bcallback\b|\bspeak (again|soon)\b/.test(t)) positive.push("requested a callback");
  if (/\binterested\b|\btell me more\b|\bsounds good\b|\blike(s)? the idea\b/.test(t)) positive.push("expressed interest");
  if (/\byes\b|\bsure\b|\babsolutely\b|\bdefin(itely|ite)\b/.test(t))       positive.push("gave positive responses");

  const outcomeMap: Record<string, string> = {
    interested:     "The contact expressed interest and the call ended positively.",
    callback:       "The contact requested a callback or follow-up conversation.",
    answered:       "The contact answered and a conversation took place.",
    not_interested: "The contact indicated they are not interested at this time.",
    no_answer:      "The call was not answered.",
    dnc:            "The contact has requested to be placed on the do-not-call list.",
  };
  const outcomeSentence = outcomeMap[outcome ?? ""] ?? "The call outcome was not categorised.";

  let durationNote = "";
  if (durationSeconds !== null) {
    if (durationSeconds < 20)       durationNote = "The call was very brief (under 20 seconds).";
    else if (durationSeconds < 60)  durationNote = `The call lasted ${Math.round(durationSeconds)} seconds — a short conversation.`;
    else if (durationSeconds < 180) durationNote = `The call ran for about ${Math.round(durationSeconds / 60)} minute(s), covering key topics.`;
    else                            durationNote = `The call was a substantive ${Math.round(durationSeconds / 60)}-minute conversation.`;
  }

  const namePart = companyName ? `${contactName} at ${companyName}` : contactName;
  const parts: string[] = [];
  parts.push(`${outcomeSentence}${durationNote ? " " + durationNote : ""}`);
  if (topics.length > 0)    parts.push(`Topics covered included ${topics.slice(0, 4).join(", ")}.`);
  if (positive.length > 0)  parts.push(`During the call, ${namePart} ${positive.join("; ")}.`);
  if (objections.length > 0) parts.push(`Objections or blockers noted: ${objections.join(", ")}.`);
  if (topics.length === 0 && positive.length === 0 && objections.length === 0)
    parts.push("The transcript did not contain strong topic or sentiment signals beyond the call outcome.");

  const aiSummary = parts.join(" ");

  const steps: string[] = [];
  if (outcome === "interested" || positive.includes("asked for follow-up materials"))
    steps.push("Send a follow-up email within 24 hours with relevant case studies or product overview.");
  if (outcome === "callback" || positive.includes("requested a callback"))
    steps.push("Schedule the callback at the agreed time and add a calendar reminder.");
  if (objections.includes("budget"))
    steps.push("Prepare a ROI or cost-justification brief tailored to their budget concern.");
  if (objections.includes("existing solution"))
    steps.push("Send a competitive comparison sheet highlighting key differentiators.");
  if (objections.includes("needs sign-off"))
    steps.push("Offer to join a call with the decision-maker or provide a concise exec summary they can share internally.");
  if (objections.includes("timing"))
    steps.push("Add contact to a nurture sequence and re-engage in 4–6 weeks.");
  if (topics.includes("a demo"))
    steps.push("Book a product demo and confirm the meeting details by email.");
  if (topics.includes("integrations"))
    steps.push("Share integration documentation and relevant API details.");
  if (outcome === "not_interested")
    steps.push("Mark as low-priority; consider re-engaging next quarter with a different angle or offer.");
  if (outcome === "no_answer")
    steps.push("Attempt a follow-up call at a different time of day; consider sending a brief email first.");
  if (outcome === "dnc")
    steps.push("Ensure this contact is permanently removed from all outbound sequences.");
  if (steps.length === 0)
    steps.push("Log call notes in CRM and follow up by email to keep the conversation warm.");

  const aiNextSteps = steps.map(s => `• ${s}`).join("\n");
  return { aiSummary, aiNextSteps };
}
