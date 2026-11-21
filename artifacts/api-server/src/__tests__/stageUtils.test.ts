/**
 * Unit tests for computeSequentialStageAdvancement (pure function, no DB).
 *
 * Covers:
 *   1. already-at-stage no-op — contact is already at the target stage
 *   2. partial advancement from mid-chain — contact is partway through the chain
 *   3. regression guard — target stage is below the contact's current stage
 *   4. full advancement from the bottom
 *   5. unknown target stage
 */
import { describe, it, expect } from "vitest";
import {
  computeSequentialStageAdvancement,
  STAGE_ORDER,
} from "../lib/stageUtils";

describe("computeSequentialStageAdvancement", () => {
  // ── 1. Already at target stage — no-op ──────────────────────────────────────
  it("returns empty stagesToAdd when contact already has the target stage tag", () => {
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      ["pre-aware", "aware"],
      "aware",
    );
    expect(stagesToAdd).toEqual([]);
    // newTags must be the same reference (no copy made when nothing changes)
    expect(newTags).toEqual(["pre-aware", "aware"]);
  });

  it("returns empty stagesToAdd when contact has the target and additional higher tags", () => {
    const currentTags = ["pre-aware", "aware", "pre-engage", "engage"];
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      currentTags,
      "engage",
    );
    expect(stagesToAdd).toEqual([]);
    expect(newTags).toEqual(currentTags);
  });

  // ── 2. Partial advancement from mid-chain ───────────────────────────────────
  it("fills in only the missing stages when contact is partway through the chain", () => {
    // Contact is at 'aware'; target is 'engage' → needs pre-engage + engage
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      ["pre-aware", "aware"],
      "engage",
    );
    expect(stagesToAdd).toEqual(["pre-engage", "engage"]);
    expect(newTags).toEqual(["pre-aware", "aware", "pre-engage", "engage"]);
  });

  it("fills in a single missing stage when only one step remains", () => {
    // Contact is at 'pre-engage'; target is 'engage'
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      ["pre-aware", "aware", "pre-engage"],
      "engage",
    );
    expect(stagesToAdd).toEqual(["engage"]);
    expect(newTags).toEqual(["pre-aware", "aware", "pre-engage", "engage"]);
  });

  it("does not duplicate a stage that already exists in currentTags even if it is below current highest", () => {
    // Contact has 'aware' and 'pre-engage' (possibly from an older import).
    // Advancing to 'engage' must not add 'aware' again.
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      ["aware", "pre-engage"],
      "engage",
    );
    expect(stagesToAdd).toEqual(["engage"]);
    expect(newTags).toEqual(["aware", "pre-engage", "engage"]);
    // 'aware' must appear exactly once
    expect(newTags.filter((t) => t === "aware")).toHaveLength(1);
  });

  // ── 3. Regression guard — target below current stage ───────────────────────
  it("returns empty stagesToAdd when the target stage is below the contact's current stage", () => {
    // Contact is at 'engage'; targeting 'aware' must be a no-op, not a regression.
    const currentTags = ["pre-aware", "aware", "pre-engage", "engage"];
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      currentTags,
      "aware",
    );
    expect(stagesToAdd).toEqual([]);
    expect(newTags).toEqual(currentTags);
  });

  it("returns empty stagesToAdd when the target is the same as a stage the contact has passed", () => {
    // Contact is at 'advance-engage'; targeting 'engage' must be a no-op.
    const currentTags = [
      "pre-aware",
      "aware",
      "pre-engage",
      "engage",
      "advance-engage",
    ];
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      currentTags,
      "engage",
    );
    expect(stagesToAdd).toEqual([]);
    expect(newTags).toEqual(currentTags);
  });

  // ── 4. Full advancement from the bottom ────────────────────────────────────
  it("returns all intermediate stages when the contact has no stage tags", () => {
    // Contact with no tags; advancing to 'pre-engage' from implicit 'pre-aware'.
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      [],
      "pre-engage",
    );
    // From pre-aware (implicit), through aware, to pre-engage
    expect(stagesToAdd).toEqual(["aware", "pre-engage"]);
    expect(newTags).toEqual(["aware", "pre-engage"]);
  });

  it("advances through the full chain from empty tags to action", () => {
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      [],
      "action",
    );
    // All stages after pre-aware (implicit start)
    expect(stagesToAdd).toEqual([
      "aware",
      "pre-engage",
      "engage",
      "advance-engage",
      "action",
    ]);
    expect(newTags).toEqual(stagesToAdd);
  });

  // ── 5. Unknown / invalid target stage ──────────────────────────────────────
  it("returns empty stagesToAdd for an unrecognised target stage name", () => {
    const currentTags = ["pre-aware", "aware"];
    const { stagesToAdd, newTags } = computeSequentialStageAdvancement(
      currentTags,
      "non-existent-stage",
    );
    expect(stagesToAdd).toEqual([]);
    expect(newTags).toEqual(currentTags);
  });
});
