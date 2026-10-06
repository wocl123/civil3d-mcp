import type { DesignChange } from "./DesignChange.js";
import type { AlignmentCreateRequest } from "../../design/types/AlignmentLayout.js";

// One way to bring a failed item within the criteria, computed in code.
// status: "feasible" fits between the neighbouring elements, "conflict" does not
// (reason says why), "unverified" changes other elements that code did not re-check.
export type FixOption = {
  // Set when the fix is stored: the id the AI passes to apply_drawing_change, and
  // whether the plug-in can apply all of its changes.
  id?: string;
  applicable?: boolean;
  title: string;
  changes: DesignChange[];
  // Set instead of changes when the option creates a new object (a planned alignment).
  create?: AlignmentCreateRequest;
  status: "feasible" | "conflict" | "unverified";
  reason?: string;
  effects: string[];
};
