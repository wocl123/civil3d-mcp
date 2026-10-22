import { AsyncLocalStorage } from "node:async_hooks";

// 재사용 서버에서도 도면·적용 권한은 질문별로 고정한다. process.env를 바꾸지 않는다.
export type PaletteContext = {
  requestId: string; drawingId: string; offeredFixes: string[]; signal?: AbortSignal;
};
const current = new AsyncLocalStorage<PaletteContext>();
export const paletteContext = () => current.getStore();
export const inPaletteContext = <T>(value: PaletteContext, work: () => T): T => current.run(value, work);
