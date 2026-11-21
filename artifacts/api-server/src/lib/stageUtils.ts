/**
 * Stage hierarchy utilities — pure functions, no DB dependencies.
 *
 * Stages are ordered lowest → highest. A contact's stage never regresses.
 * Sequential enforcement means a contact can only advance one step at a time;
 * if a journey page tags "engage" and the contact is at "pre-aware", they must
 * pass through "aware" and "pre-engage" before landing at "engage".
 */

export const STAGE_ORDER = [
  "pre-aware",
  "aware",
  "pre-engage",
  "engage",
  "advance-engage",
  "action",
] as const;

export type StageName = (typeof STAGE_ORDER)[number];

export const STAGE_RANK: Record<string, number> = Object.fromEntries(
  STAGE_ORDER.map((s, i) => [s, i]),
);

/**
 * Returns every stage name that lies strictly between `fromStage` (exclusive)
 * and `toStage` (inclusive), in ascending order.
 *
 * Examples:
 *   getStagesTo("pre-aware", "engage")       → ["aware", "pre-engage", "engage"]
 *   getStagesTo("aware",     "pre-engage")   → ["pre-engage"]
 *   getStagesTo("engage",    "engage")       → []   (already there)
 *   getStagesTo("engage",    "aware")        → []   (regression — no-op)
 */
export function getStagesTo(fromStage: string, toStage: string): string[] {
  const fromRank = STAGE_RANK[fromStage] ?? 0;
  const toRank   = STAGE_RANK[toStage]   ?? -1;
  if (toRank <= fromRank) return [];
  return (STAGE_ORDER as readonly string[]).slice(fromRank + 1, toRank + 1);
}

/**
 * Given the contact's current tags array and a desired target stage, returns:
 *  - `stagesToAdd`:  ordered list of stage tags to append (may include
 *                    intermediate stages skipped by the target); empty when the
 *                    contact is already at or past the target.
 *  - `newTags`:      the merged tags array after adding stagesToAdd.
 *
 * Any stage already present in currentTags is not duplicated.
 */
export function computeSequentialStageAdvancement(
  currentTags: string[],
  targetStage: string,
): { stagesToAdd: string[]; newTags: string[] } {
  const toRank = STAGE_RANK[targetStage] ?? -1;
  if (toRank < 0) return { stagesToAdd: [], newTags: currentTags };

  const currentHighestRank = Math.max(
    -1,
    ...currentTags.map(t => STAGE_RANK[t] ?? -1),
  );
  const fromStage =
    currentHighestRank >= 0
      ? (STAGE_ORDER[currentHighestRank] as string)
      : "pre-aware";

  const stagesToAdd = getStagesTo(fromStage, targetStage).filter(
    s => !currentTags.includes(s),
  );

  return {
    stagesToAdd,
    newTags: stagesToAdd.length > 0 ? [...currentTags, ...stagesToAdd] : currentTags,
  };
}
