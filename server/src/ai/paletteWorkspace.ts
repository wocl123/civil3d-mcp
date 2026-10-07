// 팔레트 AI를 실행할 준비: 작업 폴더, 지시문(스킬 + 공통 규칙), 모델, CLI 명령 인자.
// 사용자의 CLI 설정(플러그인, 다른 MCP 서버, 커넥터, 훅)은 넣지 않는다.
// 요청을 작게 유지하고, 이 프로젝트의 도구만 쓰게 하려는 것이다.

import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../paths.js";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import { contentVersion } from "../knowledge/contentVersion.js";
import { rulesPrompt } from "../knowledge/rulesStore.js";
import { parameterSummary } from "../knowledge/parameters.js";
import { connectionFile } from "../bridge/pluginClient.js";
import type { Provider } from "./types/Provider.js";
import type { CliLaunch } from "./types/CliLaunch.js";

// MCP 서버 이름. AI가 보는 도구 이름이 "mcp__civil3d__..."가 된다.
const SERVER_NAME = "civil3d";

// 도구 하나의 제한 시간: 폴리라인 고르기 대기(90초)보다 길고, 요청 전체(200초)보다 짧게.
const TOOL_TIMEOUT_SECONDS = 150;

const here = dirname(fileURLToPath(import.meta.url));
const mcpEntry = join(here, "..", "index.js");
const skillSource = join(here, "..", "..", "skills", "civil3d-palette", "SKILL.md");

// 팔레트가 쓰지 않는 Codex 기능. 켜 두면 매 요청에 도구 설명이 붙어 토큰을 쓰고, 일부는 코드를 실행할 수 있다.
const CODEX_DISABLED_FEATURES = [
  "apps", "browser_use", "browser_use_external", "computer_use", "goals", "hooks",
  "image_generation", "multi_agent", "plugins", "shell_tool", "skill_search",
  "sleep_tool", "tool_suggest", "unified_exec", "view_image"
];

// AI CLI의 작업 폴더 (data/ai-workspace).
function workspaceDir(): string {
  if (process.env.MY_CIVIL3D_AI_WORKSPACE) return process.env.MY_CIVIL3D_AI_WORKSPACE;
  return join(dataDir(), "ai-workspace");
}

// 내용이 바뀌었을 때만 파일을 쓴다.
async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch {
    // 없으면 아래에서 쓴다.
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

// 스킬 파일 맨 위의 --- 머리말 --- 을 뗀다.
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() + "\n";
}

// 설정 값은 cmd.exe와 TOML 문자열을 거치므로, 단순한 이름과 따옴표 없는 경로만 받는다.
function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:\-\[\]]{1,80}$/.test(value) ? value : undefined;
}

function tomlPath(path: string): string {
  if (/['"\r\n%&|<>^]/.test(path)) throw new Error(`Unsupported characters in path: ${path}`);
  return `'${path}'`;
}

type ModelChoice = { model?: string; effort?: string };

// 팔레트 AI는 사용자의 CLI 설정과 무관하게 정해진 모델을 쓴다.
// data/palette-models.json 으로 바꿀 수 있다. 예: {"claude":{"model":"opus","effort":"high"}}
const DEFAULT_MODELS: Record<Provider, ModelChoice> = {
  claude: { model: "sonnet", effort: "medium" },
  codex: { model: "gpt-5.6-sol", effort: "medium" },
  gemini: {}
};

export async function paletteModel(provider: Provider): Promise<ModelChoice> {
  let override: ModelChoice = {};
  try {
    const all = JSON.parse(await readFile(join(dataDir(), "palette-models.json"), "utf8")) as Record<string, unknown>;
    const entry = all[provider] as Record<string, unknown> | undefined;
    if (entry) override = { model: settingValue(entry.model), effort: settingValue(entry.effort) };
  } catch {
    // 바꾸는 파일이 없다.
  }
  const base = DEFAULT_MODELS[provider];
  return { model: override.model ?? base.model, effort: override.effort ?? base.effort };
}

// 매 요청의 고정 부분(지시문) = 스킬 + 공통 규칙. CLI가 캐시할 수 있다.
// 도면 지식과 질문은 그 뒤 프롬프트로 따로 간다.
async function paletteInstructions(): Promise<string> {
  const rules = await rulesPrompt();
  return stripFrontmatter(await readFile(skillSource, "utf8")) + (rules ? `
# Common rules

${rules}
` : "");
}

// 지시문·모델·승인된 설정값이 바뀌면 달라지는 값.
// 답변 재사용 키에 들어가므로, 예전 지시문이나 설정으로 만든 답은 다시 쓰지 않는다.
export async function paletteVersion(provider: Provider): Promise<string> {
  const model = await paletteModel(provider);
  const settings = JSON.stringify(await parameterSummary()) + await contentVersion();
  const instructions = await paletteInstructions();
  return createHash("sha256").update(`${model.model}|${model.effort}|${settings}|${instructions}`).digest("hex").slice(0, 16);
}

// 팔레트 AI를 실행할 CLI 인자를 만든다.
//   tools:        true면 이 프로젝트의 MCP 서버를 "palette" 프로필(읽기 전용 + 동의한 수정안 적용)로 붙인다.
//   requestId:    MCP 서버로 전달돼, 계산한 수정안과 적용한 변경에 이 요청을 표시한다.
//   offeredFixes: 이 요청에서 적용해도 되는 수정안 id(앞서 대화에서 사용자에게 보여 준 것).
export async function paletteLaunch(provider: Provider, tools: boolean, requestId = "none", offeredFixes: string[] = [], drawingId = ""):
  Promise<CliLaunch> {
  if (!/^[\w-]{1,64}$/.test(requestId)) throw new Error("Invalid request id.");

  if (!/^[\w-]{0,64}$/.test(drawingId)) throw new Error("Invalid drawing id.");
  const offered = offeredFixes.filter(id => /^fx-[a-f\d]{10}$/.test(id)).join(",");
  // 요약과 새 질문이 설정 파일(허용 수정안 포함)을 덮어쓰지 않도록 실행별 격리.
  const cwd = join(workspaceDir(), "requests", randomUUID());
  const skill = await paletteInstructions();

  // MCP 서버에 넘길 환경 변수.
  const serverEnv = {
    MY_CIVIL3D_MCP_PROFILE: "palette",
    MY_CIVIL3D_CONNECTION_FILE: connectionFile(),
    MY_CIVIL3D_KNOWLEDGE_DIR: knowledgeDir(),
    MY_CIVIL3D_DATA_DIR: dataDir(),
    MY_CIVIL3D_REQUEST_ID: requestId,
    MY_CIVIL3D_OFFERED_FIXES: offered,
    MY_CIVIL3D_DRAWING_ID: drawingId
  };

  // ── Claude: 지시문 파일과 MCP 설정 파일을 작업 폴더에 쓴다.
  if (provider === "claude") {
    await writeIfChanged(join(cwd, "palette-skill.md"), skill);
    await writeIfChanged(join(cwd, "claude-mcp.json"), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: "stdio", command: process.execPath, args: [mcpEntry], env: serverEnv } }
    }, null, 2));
    const user = await paletteModel("claude");
    return {
      cwd,
      env: {
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",                       // claude.ai 커넥터(Gmail 등)가 섞이지 않게
        MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SECONDS * 1000)       // 폴리라인 고르기 대기보다 길게
      },
      args: [
        // stream-json: 도구 호출과 답 글자를 그때그때 팔레트에 보여 줄 수 있다.
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
        "--setting-sources", "project", "--disable-slash-commands",
        "--tools", "", "--strict-mcp-config", "--system-prompt-file", "palette-skill.md",
        ...(user.model ? ["--model", user.model] : []),
        ...(user.effort ? ["--effort", user.effort] : []),
        ...(tools ? ["--mcp-config", "claude-mcp.json", "--allowedTools", `mcp__${SERVER_NAME}`] : [])
      ]
    };
  }

  // ── Codex: 지시문은 AGENTS.md, MCP 서버는 -c 설정으로 넘긴다. 사용자 설정은 무시한다.
  if (provider === "codex") {
    const instructions = join(cwd, "AGENTS.md");
    await writeIfChanged(instructions, skill);
    const user = await paletteModel("codex");
    const server = `mcp_servers.${SERVER_NAME}`;
    const envToml =
      `{MY_CIVIL3D_MCP_PROFILE='palette',MY_CIVIL3D_CONNECTION_FILE=${tomlPath(serverEnv.MY_CIVIL3D_CONNECTION_FILE)},` +
      `MY_CIVIL3D_KNOWLEDGE_DIR=${tomlPath(serverEnv.MY_CIVIL3D_KNOWLEDGE_DIR)},MY_CIVIL3D_DATA_DIR=${tomlPath(serverEnv.MY_CIVIL3D_DATA_DIR)},` +
      `MY_CIVIL3D_REQUEST_ID='${requestId}',MY_CIVIL3D_OFFERED_FIXES='${offered}',MY_CIVIL3D_DRAWING_ID='${drawingId}'}`;
    return {
      cwd,
      env: {},
      args: [
        "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
        ...CODEX_DISABLED_FEATURES.flatMap(feature => ["--disable", feature]),
        "-c", "web_search='disabled'",
        "-c", `model_instructions_file=${tomlPath(instructions)}`,
        ...(user.model ? ["-c", `model='${user.model}'`] : []),
        ...(user.effort ? ["-c", `model_reasoning_effort='${user.effort}'`] : []),
        ...(tools ? [
          "-c", `${server}.command=${tomlPath(process.execPath)}`,
          "-c", `${server}.args=[${tomlPath(mcpEntry)}]`,
          "-c", `${server}.tool_timeout_sec=${TOOL_TIMEOUT_SECONDS}`,
          "-c", `${server}.env=${envToml}`
        ] : []),
        "-"   // 프롬프트는 stdin으로
      ]
    };
  }

  // ── Gemini: 작업 폴더의 GEMINI.md 와 .gemini/settings.json 을 읽는다.
  await writeIfChanged(join(cwd, "GEMINI.md"), skill);
  await writeIfChanged(join(cwd, ".gemini", "settings.json"), JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: { command: process.execPath, args: [mcpEntry], env: serverEnv, trust: true, timeout: TOOL_TIMEOUT_SECONDS * 1000 }
    }
  }, null, 2));
  return {
    cwd,
    env: {},
    args: ["--output-format", "json", "-e", "none", ...(tools ? ["--skip-trust", "--allowed-mcp-server-names", SERVER_NAME] : [])]
  };
}
