import type { Provider } from "../../ai/types/Provider.js";
import type { TokenUsage } from "../../ai/types/TokenUsage.js";

// 저장해 둔 답변 하나(같은 AI·같은 질문·같은 도면 상태면 다시 쓴다).
export type CachedAnswer = {
  kind: "chat";
  provider: Provider;
  key: string;          // 질문 + 지시문 버전 + 앞 대화 + 선택의 해시
  question: string;
  scope: string;        // 도면 경로
  state: string;        // 도면 리비전
  answer: string;
  usage: TokenUsage;    // 처음 답할 때 쓴 토큰(재사용으로 아낀 양)
  createdAt: number;
  lastUsedAt: number;
  hits: number;         // 재사용 횟수
};
