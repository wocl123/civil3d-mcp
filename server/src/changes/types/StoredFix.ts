import type { AlignmentCriteriaInput } from "../../criteria/alignmentCriteria.js";
import type { ProfileCriteriaInput } from "../../criteria/profileCriteria.js";
import type { FixOption } from "../../criteria/types/FixOption.js";

// The check a fix came from, run again after the fix is applied; "none" when no check applies.
export type FixSource = { check: "alignment"; input: AlignmentCriteriaInput } | { check: "profile"; input: ProfileCriteriaInput } | { check: "none" };

// A fix as stored under data/changes/fixes.
export type StoredFix = FixOption & {
  id: string; applicable: boolean; target: string; check: string; createdAt: string; requestId: string; source: FixSource;
};
