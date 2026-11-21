/** Source text only: never use AI conclusions, retrieval queries or event labels as proof. */
export function isResearchPageFurniture(text: string) {
  return /#{3,}|\bcase stud(?:y|ies)\b|\bcustomer (?:success )?stor(?:y|ies)\b/i.test(text)
    || (text.match(/\b(?:learn more|read more)\b/gi)?.length ?? 0) >= 3;
}

export function researchSourceText(excerpt: string | null | undefined, context?: Record<string, any>) {
  return typeof context?.originalExcerpt === "string" && context.originalExcerpt.trim()
    ? context.originalExcerpt : String(excerpt ?? "");
}

export const WORKFORCE_CONTRACTION = /\b(layoffs?|redundan(?:t|cy|cies)|job cuts?|hiring freeze|workforce reduction|downsizing)\b|\b(cut(?:ting|s)?|reduc(?:e|ed|ing)|shed(?:ding)?|eliminat(?:e|ed|ing)|slash(?:ed|ing)?)\b[^.!?]{0,65}\b(jobs?|roles?|employees?|staff|workforce|headcount)\b|\b(jobs?|workforce|headcount)\b[^.!?]{0,40}\b(cut|reduc(?:ed|tion)|declin(?:e|ed))\b/i;
const GROWTH = /\b(hir(?:e|es|ed|ing)|recruit(?:s|ed|ing|ment)|add(?:s|ed|ing)?|onboard(?:s|ed|ing)?|creat(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|grew|grow(?:s|ing|th)?|expand(?:s|ed|ing)?)\b/i;
const TRANSFER_OR_STOCK = /\b(transferr?(?:ed|ing)?|reassign(?:ed|ing)?|redeploy(?:ed|ing)?|relocat(?:e|ed|ing|ion)|mov(?:e|ed|ing)|existing|current|already|previously)\b/i;
const COUNT = /\b(\d[\d,]*)\s*(?:new\s+)?(?:(?:sales|customer service|customer support|support|office|software|it)\s+)?(people|employees|agents|hires|staff|users|jobs|roles|seats)\b/gi;
const CONTACT_CENTER = /\b(contact cent(?:er|re)|call cent(?:er|re)|customer service agents?|support agents?|inside sales agents?)\b/i;

export type WorkforcePassageFact = {
  passage: string;
  operation: string | null;
  location: string | null;
  contraction: boolean;
  growthHeadcount: number;
  staffedCapacity: number;
};

export function sourcePassages(text: string) {
  return text.split(/(?<=[.!?])\s+|\n+/).map(value => value.trim()).filter(Boolean);
}

/** Keep independent requirements apart, even when a publisher uses one sentence. */
export function sourceRequirementPassages(text: string) {
  return sourcePassages(text).flatMap(sentence => sentence.split(
    /;\s*|,\s*(?=(?:while|whereas|although|but|however|meanwhile|separately|its|their|the company)\b)|\b(?:while|whereas|although|but|however|meanwhile|separately)\b|\band\s+(?=(?:its|their|the company)\b)/i,
  )).map(passage=>passage.trim()).filter(Boolean);
}

/** No pronoun resolution or cross-passage count borrowing: ambiguous scopes stay context. */
export function workforcePassageFacts(text: string): WorkforcePassageFact[] {
  const passages = sourceRequirementPassages(text).flatMap(passage => passage.split(
    /\band\s+(?=(?:(?:is|will|plans to|has)\s+)?(?:hir(?:e|ing)|recruit|open|launch|start|cut|reduc|relocat|transfer)\b)|,\s*(?=(?:a|the|its)\s+(?:new\s+)?(?:contact cent(?:er|re)|call cent(?:er|re)|office|division)\b)/i,
  )).map(passage => passage.trim()).filter(Boolean);
  const facts = passages.map(passage => {
    const operation = CONTACT_CENTER.exec(passage)?.[0]
      ?? /\b(?:software developers?|it staff|office employees|office staff|sales team|[\w-]+ division)\b/i.exec(passage)?.[0] ?? null;
    const locations = [...passage.matchAll(/\b(?:in|at|from|to|for)\s+([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)/g)].map(match => match[1]);
    const fact: WorkforcePassageFact = {
      passage, operation, location: locations.length === 1 ? locations[0] : null,
      contraction: WORKFORCE_CONTRACTION.test(passage), growthHeadcount: 0, staffedCapacity: 0,
    };
    // A clause containing multiple sites or a transfer does not establish new demand at either.
    if (fact.contraction || TRANSFER_OR_STOCK.test(passage) || locations.length > 1
      || /\b(could|may|might|potential(?:ly)?|up to|not|never|no)\b/i.test(passage)
      || (CONTACT_CENTER.test(passage) && /\b(?:division|plant|warehouse|office(?!\s+(?:employees|staff)))\b/i.test(passage))) return fact;
    const newCenter = /\bnew (?:contact|call) cent(?:er|re)\b/i.test(passage)
      && /\b(start(?:ing|ed)?|launch(?:ing|ed)?|open(?:ing|ed)?)\b/i.test(passage);
    for (const match of passage.matchAll(COUNT)) {
      // "10,000 square feet ... 200 employees" must not interpret the area as people.
      // Seats describe capacity only when explicitly tied to a staffed operation.
      if (match[2].toLowerCase() === "seats" && !/\b(contact cent(?:er|re)|call cent(?:er|re)|staffed)\b/i.test(passage)) continue;
      if (match[2].toLowerCase() === "users") continue;
      const prefix = passage.slice(Math.max(0, match.index! - 30), match.index);
      if (/[$₹£€]|\b(?:rs|inr|usd|gbp)\s*$/i.test(prefix) || /\b(?:up to|could|may|potential(?:ly)?)\s*$/i.test(prefix)) continue;
      if (/\b(?:existing|current|total|already|employs?|has|relocat(?:e|ing|ed)|mov(?:e|ing|ed))\b/i.test(prefix)) continue;
      // Direction must be tied to the counted people, not a site opening or
      // unrelated growth elsewhere in the sentence.
      const directionPrefix=passage.slice(Math.max(0,match.index! - 90),match.index);
      if (/\b(could|may|might|potentially)\b/i.test(directionPrefix)) continue;
      const hiringCount=/\b(hir(?:e|es|ed|ing)|recruit(?:s|ed|ing)|add(?:s|ed|ing)?|onboard(?:s|ed|ing)?|creat(?:e|es|ed|ing))\s+(?:(?:about|approximately|around|over|more than|another|an additional|a further|a total of|new|for)\s+)*$/i.test(directionPrefix);
      const increaseCount=/\b(?:workforce|headcount|staff)\s+(?:(?:has|will|is)\s+)?(?:increas(?:e|ed|ing)|grew|grow(?:ing)?|expand(?:ed|ing)?)\s+by\s+(?:(?:about|approximately|around|an additional)\s+)*$/i.test(directionPrefix)
        || /\b(?:increas(?:e|ed|ing)|expand(?:ed|ing)?)\s+(?:its|the)\s+(?:workforce|headcount|staff)\s+by\s+(?:(?:about|approximately|around|an additional)\s+)*$/i.test(directionPrefix);
      const count = Number(match[1].replace(/,/g, ""));
      if (!Number.isSafeInteger(count) || count <= 0) continue;
      if (GROWTH.test(passage) && (hiringCount || increaseCount) && match[2].toLowerCase() !== "seats") {
        fact.growthHeadcount = Math.max(fact.growthHeadcount, count);
      }
      // Capacity must be explicitly attached to the new center, not another operation.
      const capacityPrefix = passage.slice(0, match.index);
      if (newCenter && /\b(?:new (?:contact|call) cent(?:er|re))\b[^,;.!?]*\b(?:with|staffed by|staffed with|employing)\s+(?:(?:about|approximately|around|over|more than|new)\s+)*$/i.test(capacityPrefix)) {
        fact.staffedCapacity = Math.max(fact.staffedCapacity, count);
      }
    }
    return fact;
  });
  // A contrast word alone does not prove independent operations. Keep cuts and
  // transfers from being detached from the very center whose capacity they qualify.
  const adverse = facts.filter(fact => fact.contraction || TRANSFER_OR_STOCK.test(fact.passage));
  for (const fact of facts) {
    const conflicts = adverse.some(other => {
      const differentLocation = fact.location && other.location
        && fact.location.toLowerCase() !== other.location.toLowerCase();
      const sameCenterFamily = fact.operation && other.operation
        && CONTACT_CENTER.test(fact.operation) && CONTACT_CENTER.test(other.operation);
      const differentOperation = fact.operation && other.operation && !sameCenterFamily
        && fact.operation.toLowerCase() !== other.operation.toLowerCase();
      return !differentLocation && !differentOperation;
    });
    if (conflicts) {
      fact.growthHeadcount = 0;
      fact.staffedCapacity = 0;
    }
  }
  return facts;
}

export function workforceFacts(text: string) {
  return {
    contraction: WORKFORCE_CONTRACTION.test(text),
    growthHeadcount: Math.max(0, ...workforcePassageFacts(text).map(fact => fact.growthHeadcount)),
  };
}

/** New staffed-operation capacity can support deployment, but is not a claim of net hiring. */
export function newContactCenterCapacity(text: string) {
  return Math.max(0, ...workforcePassageFacts(text).map(fact => fact.staffedCapacity));
}

export function hasOperationalSupport(text: string) {
  return /\b(deploy(?:ed|ing|ment)?|implement(?:ed|ing|ation)?|refresh|replac(?:e|ed|ing|ement)|rollout|roll out|migrat(?:e|ed|ing|ion)|upgrad(?:e|ed|ing)|need(?:s|ed)?|require(?:s|d|ment)?|capacity constraint|shortage|outage|breach|ransomware|end[- ]of[- ]support|rfp|rfq|tender|purchase order|procurement|buy(?:ing)?|purchas(?:e|ed|ing)|vendor evaluation)\b/i.test(text);
}
