import { AsyncLocalStorage } from "node:async_hooks";

// 요청별 도면 문맥으로 동시 작업의 상태가 섞이지 않도록 한다.
export type DrawingContext = { drawingId: string; revision: string; criteriaVersion?: string };
const context = new AsyncLocalStorage<DrawingContext>();
export const drawingContext = () => context.getStore();
export const inDrawingContext = <T>(value: DrawingContext, work: () => Promise<T>): Promise<T> => context.run(value, work);
