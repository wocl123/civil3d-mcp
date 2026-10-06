// One value a fix would change, in a form a later "apply" step can execute.
// object.kind names what is changed; handle and at locate it in the drawing.
export type DesignChange = {
  object: { kind: "profileCurve" | "profilePvi" | "profileTangent" | "alignmentArc" | "alignmentSpiral" | "alignment"; handle: string; at?: number };
  property: string;
  from?: number;
  to: number;
  unit: string;
};
