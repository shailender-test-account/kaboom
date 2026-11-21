export type CategoryIntentCandidate = {
  categoryName:string;
  score:number;
  tier:string;
  source:string;
};

export function isExplicitFirstPartyIntent(candidate:CategoryIntentCandidate){
  return candidate.source==="questionnaire"||candidate.source==="lead_form";
}

export function intentTierRank(tier:string|null|undefined){
  return tier==="hot"?3:tier==="warm"?2:tier==="emerging"?1:0;
}

export function isStrongerIntentCandidate(next:CategoryIntentCandidate,current:CategoryIntentCandidate){
  const nextIsExplicit=isExplicitFirstPartyIntent(next);
  const currentIsExplicit=isExplicitFirstPartyIntent(current);
  if(nextIsExplicit!==currentIsExplicit)return nextIsExplicit;
  const tierDifference=intentTierRank(next.tier)-intentTierRank(current.tier);
  if(tierDifference!==0)return tierDifference>0;
  if(next.score!==current.score)return next.score>current.score;
  return next.source==="questionnaire"&&current.source==="lead_form";
}

export function selectCanonicalCategoryIntent<T extends CategoryIntentCandidate>(candidates:T[]){
  return candidates.reduce<T|null>((best,candidate)=>!best||isStrongerIntentCandidate(candidate,best)?candidate:best,null);
}