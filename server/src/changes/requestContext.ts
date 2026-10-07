import { AsyncLocalStorage } from "node:async_hooks";

// MCP는 프로세스 환경, HTTP 버튼은 요청별 문맥에서 ID를 읽는다. 전역 환경을 바꾸지 않는다.
const request = new AsyncLocalStorage<string>();
export const currentRequestId = () => request.getStore() ?? process.env.MY_CIVIL3D_REQUEST_ID ?? "none";
export const inChangeRequest = <T>(id: string, work: () => Promise<T>) => request.run(id, work);
