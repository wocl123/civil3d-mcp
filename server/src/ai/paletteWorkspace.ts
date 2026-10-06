import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../paths.js";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import { rulesPrompt } from "../knowledge/rulesStore.js";
import { connectionFile } from "../bridge/pluginClient.js";
import type { Provider } from "./types/Provider.js";
import type { CliLaunch } from "./types/CliLaunch.js";

const SERVER_NAME = "civil3d";
// Longer than the pick prompt (90 s), shorter than the whole request (200 s).
const TOOL_TIMEOUT_SECONDS = 150;
const here = dirname(fileURLToPath(import.meta.url));
const mcpEntry = join(here, "..", "index.js");
const skillSource = join(here, "..", "..", "skills", "civil3d-palette", "SKILL.md");

// Codex features that add tool definitions the palette never uses. Each one
// costs input tokens on every request and some can run code.
const CODEX_DISABLED_FEATURES = [
  "apps", "browser_use", "browser_use_external", "computer_use", "goals", "hooks",
  "image_generation", "multi_agent", "plugins", "shell_tool", "skill_search",
  "sleep_tool", "tool_suggest", "unified_exec", "view_image"
];

function workspaceDir(): string {
  if (process.env.MY_CIVIL3D_AI_WORKSPACE) return process.env.MY_CIVIL3D_AI_WORKSPACE;
  return join(dataDir(), "ai-workspace");
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch { /* Missing files are written below. */ }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() + "\n";
}

// Values travel through cmd.exe and TOML literal strings, so only plain
// identifiers and quote-free paths are accepted.
function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.:\-\[\]]{1,80}$/.test(value) ? value : undefined;
}

function tomlPath(path: string): string {
  if (/['"\r\n%&|<>^]/.test(path)) throw new Error(`Unsupported characters in path: ${path}`);
  return `'${path}'`;
}

type ModelChoice = { model?: string; effort?: string };

// The palette AI uses its own models, independent of the user's CLI settings.
// data/palette-models.json can override them, e.g. {"claude":{"model":"opus","effort":"high"}}.
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
  } catch { /* No override file. */ }
  const base = DEFAULT_MODELS[provider];
  return { model: override.model ?? base.model, effort: override.effort ?? base.effort };
}

// The skill and the common rules form the stable system part of every request,
// which the CLIs can cache; drawing knowledge and the question follow in the prompt.
async function paletteInstructions(): Promise<string> {
  const rules = await rulesPrompt();
  return stripFrontmatter(await readFile(skillSource, "utf8")) + (rules ? `
# Common rules

${rules}
` : "");
}

// Changes whenever the instructions or the model change, so saved answers made
// under an older skill, rule set, or model are not reused.
export async function paletteVersion(provider: Provider): Promise<string> {
  const model = await paletteModel(provider);
  return createHash("sha256").update(`${model.model}|${model.effort}|${await paletteInstructions()}`).digest("hex").slice(0, 16);
}

// Builds the CLI arguments for the palette AI. User CLI customizations
// (plugins, other MCP servers, connectors, hooks) are left out to keep each
// request small and read-only; the model comes from paletteModel.
// With tools enabled, the CLI gets this project's MCP server in its read-only palette profile.
// requestId reaches the MCP server, which tags the fixes it computes and the changes it applies.
export async function paletteLaunch(provider: Provider, tools: boolean, requestId = "none", offeredFixes: string[] = []): Promise<CliLaunch> {
  if (!/^[\w-]{1,64}$/.test(requestId)) throw new Error("Invalid request id.");
  // Fix ids the AI may apply in this request: those shown to the user earlier in the conversation.
  const offered = offeredFixes.filter(id => /^fx-[a-f\d]{10}$/.test(id)).join(",");
  const cwd = workspaceDir();
  const skill = await paletteInstructions();
  const serverEnv = {
    MY_CIVIL3D_MCP_PROFILE: "palette", MY_CIVIL3D_CONNECTION_FILE: connectionFile(), MY_CIVIL3D_KNOWLEDGE_DIR: knowledgeDir(),
    MY_CIVIL3D_DATA_DIR: dataDir(), MY_CIVIL3D_REQUEST_ID: requestId, MY_CIVIL3D_OFFERED_FIXES: offered
  };

  if (provider === "claude") {
    await writeIfChanged(join(cwd, "palette-skill.md"), skill);
    await writeIfChanged(join(cwd, "claude-mcp.json"), JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: "stdio", command: process.execPath, args: [mcpEntry], env: serverEnv } }
    }, null, 2));
    const user = await paletteModel("claude");
    return {
      cwd,
      // A pick prompt waits up to 90 s for the user; the tool timeout must outlast it.
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false", MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SECONDS * 1000) },
      args: [
        // stream-json lets the palette show tool calls and answer text as they happen.
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
        "--setting-sources", "project", "--disable-slash-commands",
        "--tools", "", "--strict-mcp-config", "--system-prompt-file", "palette-skill.md",
        ...(user.model ? ["--model", user.model] : []),
        ...(user.effort ? ["--effort", user.effort] : []),
        ...(tools ? ["--mcp-config", "claude-mcp.json", "--allowedTools", `mcp__${SERVER_NAME}`] : [])
      ]
    };
  }

  if (provider === "codex") {
    const instructions = join(cwd, "AGENTS.md");
    await writeIfChanged(instructions, skill);
    const user = await paletteModel("codex");
    const server = `mcp_servers.${SERVER_NAME}`;
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
          "-c", `${server}.env={MY_CIVIL3D_MCP_PROFILE='palette',MY_CIVIL3D_CONNECTION_FILE=${tomlPath(serverEnv.MY_CIVIL3D_CONNECTION_FILE)},` +
            `MY_CIVIL3D_KNOWLEDGE_DIR=${tomlPath(serverEnv.MY_CIVIL3D_KNOWLEDGE_DIR)},MY_CIVIL3D_DATA_DIR=${tomlPath(serverEnv.MY_CIVIL3D_DATA_DIR)},` +
            `MY_CIVIL3D_REQUEST_ID='${requestId}',MY_CIVIL3D_OFFERED_FIXES='${offered}'}`
        ] : []),
        "-"
      ]
    };
  }

  // Gemini reads GEMINI.md and the workspace settings from its working directory.
  await writeIfChanged(join(cwd, "GEMINI.md"), skill);
  await writeIfChanged(join(cwd, ".gemini", "settings.json"), JSON.stringify({
    mcpServers: { [SERVER_NAME]: { command: process.execPath, args: [mcpEntry], env: serverEnv, trust: true, timeout: TOOL_TIMEOUT_SECONDS * 1000 } }
  }, null, 2));
  return {
    cwd,
    env: {},
    args: ["--output-format", "json", "-e", "none",
      ...(tools ? ["--skip-trust", "--allowed-mcp-server-names", SERVER_NAME] : [])]
  };
}
