import type { Provider } from "../../ai/types/Provider.js";
import type { TokenUsage } from "../../ai/types/TokenUsage.js";

export type CachedAnswer = {
  kind: "chat";
  provider: Provider;
  key: string;
  question: string;
  scope: string;
  state: string;
  answer: string;
  usage: TokenUsage;
  createdAt: number;
  lastUsedAt: number;
  hits: number;
};
