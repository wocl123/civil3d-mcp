// 공통 규칙 파일 하나. always면 매 요청에 들어간다.
export type KnowledgeRule = { name: string; description: string; always: boolean; body: string };
