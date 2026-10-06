import type { KnowledgeFact } from "./KnowledgeFact.js";
import type { ParameterKey } from "../parameters.js";

// AI가 <facts>로 제안한 사실 하나.
//   replaces:  이 사실이 고치는 옛 사실의 id
//   scope:     "general"이면 도면 하나를 넘어서는 관행. 도면 사실이 아니라 지식 후보가 되어 사람이 승인한다.
//   parameter: 그 관행에 해당하는 설정값(knowledge/parameters.ts). 승인되면 코드가 직접 쓴다.
export type FactProposal = Pick<KnowledgeFact, "title" | "content" | "basis" | "evidence"> & {
  replaces?: string;
  scope?: "general";
  parameter?: { key: ParameterKey; value: number };
};
