import { dirname, join, delimiter } from "node:path";
import { appDataDir } from "../paths.js";
import type { Provider } from "./types/Provider.js";

// 설치 창과 CLI 실행은 동일한 런타임·prefix를 쓴다. 사용자 PATH를 영구 수정하지 않는다.
export const runtimeNode = () => process.env.MY_CIVIL3D_NODE_EXE ?? process.execPath;
export const runtimeDir = () => dirname(runtimeNode());
export const cliPrefix = (provider: Provider) => join(process.env.MY_CIVIL3D_CLI_ROOT ?? join(appDataDir(), "cli"), provider);
export const withRuntimePath = (dirs: string[]) => [...new Set([runtimeDir(), ...dirs])].join(delimiter);
