import type { CachedAnswer } from "./CachedAnswer.js";

// 답변 재사용 파일(data/memory/answers.json)의 모양.
export type PaletteMemory = { version: 1; answers: CachedAnswer[] };
