# My Civil 3D MCP

Civil 3D 2025 plug-in with an in-app AI palette, a local Node service, and an MCP
stdio entry point. The palette tests AI sign-in, chat about the open drawing,
usage, drawing knowledge, and answer reuse. MCP exposes drawing inspection, design criteria checks, computed fixes, and
alignment creation. The palette provides Apply and Undo buttons for proposed changes.

## Build

Requires Civil 3D 2025, .NET 8 SDK, Node.js 20 or later, and npm. Build the Node
service before loading the plug-in so the plug-in can launch it automatically.

```powershell
cd .\server
npm install
npm --prefix .\claude-quota install
npm run build
cd ..
dotnet build .\plugin\MyCivil3DMcp.Plugin.csproj -c Release
```

The C# project builds against the Civil 3D 2025 API and resolves its DLLs from
`C:\Program Files\Autodesk\AutoCAD 2025` (with `C3D` and `ACA`). Civil 3D 2026
belongs to the same R25 release family, so the 2025 build is expected to load
there as well; this has not been verified. To build against another
installation, set MSBuild `AcadDir` (for example
`dotnet build ... -p:AcadDir="C:\Program Files\Autodesk\AutoCAD 2026"`). Set `CivilDir` or `AecDir` as well when those folders are elsewhere. Autodesk
binaries are not bundled.

## Source layout

```text
plugin/
  Commands/       Civil 3D command entry point
  Drawing/        read-only drawing queries and one model type per file
  Civil/          alignment and profile snapshots and queries, fixes and alignment creation, and their models
  UI/             WPF chat palette, theme colors, and the local service client
  Mcp/            authenticated plug-in bridge and Node service launcher
server/src/
  mcp/            stdio server, tool profiles, and drawing tool registrations
  bridge/         TCP client for the Civil 3D plug-in
  ai/             CLI adapters, usage, quota, and individual data types
  service/        local palette HTTP API
  workflows/      palette chat
  civil/          section reader and the Civil 3D value types server code uses
  criteria/       design criteria data access and the code that compares drawings with it
  design/         layouts planned in code before anything is drawn (alignment from polyline)
  changes/        stored fixes and plans, applying them, and the change log
  knowledge/      per-drawing knowledge, candidates, settings (parameters), central knowledge
  memory/         palette answer reuse and drawing state
  data/           anonymous install id, Google Drive settings, team mail, words never to send
  logs/           local work logs (never leave this PC as they are)
  tracking/       values the AI set, read again to see whether people changed them
  sync/           de-identified records, outbox, sync loop, retention
  drive/          Google Drive send folder: find "My Drive", member side of the sync
  admin/          admin PC: store, review, checks, problem cases, releases
server/skills/    palette AI skill shared by Claude, Codex, and Gemini
server/knowledge-defaults/  common rules and criteria tables installed into data/knowledge
docs/             design documents (데이터관리_설계.md)
```

`server/src/index.ts`, `server/src/localService.ts`, and
`server/src/claudeStatusline.ts` remain thin entry points, so existing launch
paths do not change. C# declarations and named Node data types each have
their own file.

## Use inside Civil 3D

1. Open Civil 3D 2025. Run `NETLOAD` and select
   `plugin\bin\Release\net8.0-windows\MyCivil3DMcp.Plugin.dll`.
2. Run `MYC3DCONNECTION` to check the plug-in bridge and local Node service.
3. Run `MYC3DCHAT` to open the dockable AI palette (WPF). The top row shows
   Claude, Codex, and Gemini with their sign-in state; the conversation appears
   as bubbles, with answers rendered from a small Markdown subset (headings,
   bold, lists, tables) and a 복사 button that copies tables as tab-separated
   rows for Excel; the bottom line shows this question's tokens, the session total,
   and the account's remaining quota (↻ refreshes it).
4. Click an AI to use it. An unchecked AI is checked first and becomes usable
   only after its installed CLI confirms an existing account login.
5. Type a question and press Enter (Shift+Enter adds a line). While the AI
   works, the answer shows what it is doing (for example 종단 기준 검토 중) and the
   elapsed seconds; Claude's text appears as it arrives, Codex's when complete.
   The palette reads this from `/api/chat/stream`, one JSON event per line; the
   `<facts>` block is held back. Each request also starts with a short list of the
   drawing's alignments and profiles, so the AI can call tools by name at once.
   The whole conversation goes with each question until **새 대화**, so follow-ups
   such as 나머지도 보여줘 work, also after switching AI. The newest turns are sent
   whole. Like `/compact`, once the turns not yet summarized pass about 12,000
   characters, the AI folds all but the newest four into a summary after the
   answer is sent (names, conditions, conclusions, open items); typing `/compact`
   does it at once and shows the summary. Until a summary exists, older answers
   are shortened and the oldest kept as questions only. The conversation is kept
   in the service's memory only, so it ends when Civil 3D closes.
   Answers can be selected and copied. **새 대화** starts a new conversation; drawing knowledge and
   saved answers stay. The palette follows the Civil 3D dark or light theme.

The plug-in starts the Node service automatically from `server/build/localService.js`.
If the Node executable or built service is elsewhere, set
`MY_CIVIL3D_SERVER_ENTRY` to the absolute path of `localService.js` before opening
Civil 3D. The service listens only on `127.0.0.1:48900`, accepts the plug-in's
session token, and has no browser page. Set `MY_CIVIL3D_SERVICE_PORT` before
opening Civil 3D to use another service port.

The plug-in bridge listens on `127.0.0.1:48761` by default. Set
`MY_CIVIL3D_PORT` before launching Civil 3D to change it. The bridge writes its
port and random token to `%LOCALAPPDATA%\MyCivil3DMcp\connection.json`; keep this
file private. `MYC3DSTATUS` and `MYC3DOBJECTS` remain available as direct
Civil 3D commands for testing the read-only drawing queries.

## Existing CLI accounts

| AI | Check | Sign in if unavailable |
| --- | --- | --- |
| Claude | `claude auth status` | `claude auth login` |
| Codex | `codex login status` | `codex login` |
| Gemini | Short headless model request | Run `gemini` and complete its login |

The palette never asks for passwords or API keys. Gemini's check can use account
quota because its CLI has no documented noninteractive login-status command.
A confirmed login is a session of 30 minutes from its last use
(`MY_CIVIL3D_AI_SESSION_MINUTES`): every question to that AI starts the time again,
and the palette shows the time left on the AI (사용 중 · 29:41). An AI left unused
that long is released and is confirmed again when picked.

The service finds each CLI where it really is (`server/src/ai/cliLocator.ts`): the
current PATH, the user and machine PATH read fresh from the registry, and the
official install folders (`%USERPROFILE%\.local\bin`, `%APPDATA%\npm`). A CLI
installed after Civil 3D started is therefore found without restarting.

Picking an AI in the palette that is not installed asks first: "설치할까요?" with
[설치] and [취소]. Only [설치] opens `server\setup\setup-ai-cli.ps1 -Provider <ai>
-Action install` for that one AI in its own PowerShell window: Claude's official
installer (`irm https://claude.ai/install.ps1 | iex`), or `npm install -g @openai/codex`
/ `@google/gemini-cli` (Node.js is already required), followed by the CLI's own sign-in
in the browser with the user's own account. An installed AI whose login is not
confirmed asks "로그인할까요?" the same way (`-Action login`). Afterwards, clicking the
AI again checks it. `npm run smoke:cli` checks that the script is valid PowerShell,
runs its read-only `-Action check` for each AI, and checks that installed CLIs are
found with a stale PATH.

## Palette AI, MCP, and memory

All user data lives in one folder per Windows user,
`%LOCALAPPDATA%\MyCivil3DMcp\data`, never in the installation folder, so it is
never split between two places: answer memory, knowledge, logs, tracking of AI
results, the outgoing queue, and the AI workspace. Set `MY_CIVIL3D_DATA_DIR`
before opening Civil 3D to choose another folder. The connection file with the
session token stays in `%LOCALAPPDATA%\MyCivil3DMcp`. How data is stored,
de-identified, sent to the admin through Google Drive, and deleted is specified in
[docs/데이터관리_설계.md](docs/데이터관리_설계.md).

Palette chat questions reach the selected CLI with this project's MCP server in
its read-only `palette` profile (`MY_CIVIL3D_MCP_PROFILE=palette`). That profile
registers closed-world read-only tools and the guarded `apply_drawing_change` tool.
Other drawing writes and external-file tools are excluded.

The palette rules live in one skill, `server/skills/civil3d-palette/SKILL.md`.
The service writes it to `data\ai-workspace` in the form each
CLI reads, and starts the CLI there:

| AI | Skill delivery | Context left out |
| --- | --- | --- |
| Claude | Replaces the default system prompt (`--system-prompt-file`) | Built-in tools, claude.ai connectors, other MCP servers, skills, user hooks and settings |
| Codex | Replaces the built-in instructions (`model_instructions_file`) | User config, plugins, shell, browser, and other built-in tools |
| Gemini | `GEMINI.md` in the workspace | Extensions and other MCP servers |

The palette uses its own models, not the user's CLI settings: Claude `sonnet`
with `medium` effort and Codex `gpt-5.6-sol` with `medium` reasoning effort.
To change them, create `data/palette-models.json`, for example
`{"claude": {"model": "opus", "effort": "high"}, "codex": {"model": "gpt-6-sol"}}`;
fields left out keep the defaults. Edits to the skill file apply to the next question. Gemini's setup follows its documented settings format but was
not verified: the test account's Gemini CLI login was rejected by Google
(`IneligibleTierError`).

### Knowledge

`data\knowledge` has two layers:

```text
data/knowledge/
  rules/       common rules for every drawing, written by people
  drawings/    one file per drawing with confirmed facts, added by the AI
```

**Common rules.** The service installs each rule in
`server/knowledge-defaults/rules` once and records it in `rules\.installed`, so
rules added in later versions arrive while edited or deleted files stay as they
are. Edit them to match your team's practice:

| File | Use |
| --- | --- |
| `00_핵심규칙.md` | Core rules marked `always: true`; sent with every request, so keep it short |
| `도면_읽기규칙.md` | What the tools can and cannot read, layer states, units, large drawings |
| `객체_용어.md` | Korean terms for the object types the tools return |
| `레이어_규약.md` | Your team's layer naming; rows marked 예시 are ignored |
| `선형.md` | Alignment types, stations, length, elements, and design speed |
| `종단.md` | Profile types, grades, vertical curves and sight distance values, PVIs, elevations at stations, profile views |
| `설계기준.md` | How to check design criteria: use the check tools, ask for missing conditions, cite articles |
| `설계기준_도로구조규칙_일반·평면·종단.md` | Law article text by topic, generated by `npm run law:fetch`; do not edit |

**Design criteria.** Checking a drawing against criteria is split into layers,
so that other checks can follow the same pattern:

| Layer | Where | Role |
| --- | --- | --- |
| Drawing values | plug-in (`alignment.*`, `profile.*`) | Reads Civil 3D values only |
| Criteria tables | `data\knowledge\criteria\<id>.json` | Limits as data: table, article, unit, `min` or `max`, conditions (`when`), value, and the source line each row came from |
| Comparison | `server/src/criteria` | Code compares drawing values with the tables and returns pass, fail, or n/a per item, with conditions still needed |
| Explanation | AI with `설계기준.md` | Calls the check tool, asks for missing conditions, and explains the result with articles |

`npm run law:fetch` downloads the current 「도로의 구조ㆍ시설 기준에 관한 규칙」 from
the law.go.kr Open API, writes its articles by topic to the three
`설계기준_도로구조규칙_*` rule files, keeps the full response in
`data\knowledge\criteria\source`, and reports whether the law was revised. It
then checks that every criteria row's source line still appears in the article it
cites and stores the result in the criteria file (`verification`); the check tools
report it. The API key (OC) is read from `%LOCALAPPDATA%\MyCivil3DMcp\law-api.json`
as `{"oc": "..."}`. Owner criteria such as 한국도로공사 도로설계요령 or LH guidelines
are not in the law API; they can be added later as another criteria JSON file.

Failed items carry fixes computed in `server/src/criteria/fixes`: a larger
radius at the same deflection angle, a longer curve, added spirals, a longer
vertical curve at the same PVI, or a PVI elevation change. Each fix lists the
values to change (`changes`: object, property, from, to) in a form a later apply
step can use, its effects, and a status: `feasible` (fits between the neighbouring
elements), `conflict` (does not; `reason` says why), or `unverified` (other
elements change too). Fixes are computed one at a time; combining two fixes on
the same curve is not checked.

**Applying a fix.** The user can press **적용하기** on a proposal card or agree in the conversation
(for example 1안으로 해줘). The AI never sends arbitrary values to the drawing:

1. The check tools store every fix in `data\changes\fixes` with an id (`fx-…`),
   whether the plug-in can apply it (`applicable`), and the check that produced it.
   The ids of an answer's fixes go into the conversation, not the shown answer.
2. When the user's message clearly agrees to one fix, the AI calls
   `apply_drawing_change(fixId)`. The service passes the ids offered in the last
   three answers (`MY_CIVIL3D_OFFERED_FIXES`); any other id is refused, so the AI
   can only apply a fix the user has seen. A request for an arbitrary value
   ("반지름 500으로 바꿔줘") is not possible.
3. The plug-in (`change.apply`, `plugin/Civil/DesignChanges.cs`) applies all
   values in one transaction inside one UNDO group, so one Ctrl+Z reverts them.
   The drawing instance and revision must still match the proposal, and each
   value must still equal its original value; otherwise nothing changes.
4. The same check then runs again, and the answer says whether the target now
   passes. If it still fails, the AI explains why and asks what to do next
   (another fix, a change by hand, or undo). The palette shows a card with **적용하기** and **되돌리기**. Undo is accepted only
   when the operation is still the latest edit in that drawing; another user edit
   causes refusal. A verified undo permits applying the proposal again. Every attempt is logged in `data\logs\<date>\changes.jsonl`, and the values set
   are tracked to see whether people change them later (`server/src/tracking`).

`apply_drawing_change` is the only tool in the palette profile that is not
read-only. Applied automatically today: PVI elevation, vertical curve length (at
its PVI), the radius of a single arc, and a new alignment from a plan. Adding spirals and changing
superelevation are shown as fixes to make by hand.

**Creating an alignment from a polyline.** The palette works in turns, as the
`선형생성` rule describes. A polyline the user selected before asking is used at once:
the plug-in records each drawing's selection when it changes (`drawing.selection`),
and every palette question carries it (it is also part of the answer-reuse key).
Otherwise the AI calls `pick_polyline`: the Civil 3D command line
asks the user to click the polyline (the palette shows the same request), and the
AI waits up to 90 seconds. ESC or no pick within that time cancels; the user can
then pick again or ask for a list (`list_polylines`). The CLIs' MCP tool timeout is
150 seconds so the wait fits. The AI then asks in one question what the alignment
is for: one or more of 도로, 관망, 수로/하천, 구조물, 기타 (a road centerline that the
pipe network also follows is "도로, 관망"). For a road it also asks the criteria
(도로구조규칙 or LH_설계지침_토목), the road class, and the area and terrain. The
design speed is not asked: code takes it from the 제8조 table for that class and
area (`designSpeedLimits` in `server/src/criteria/designSpeed.ts`). A speed the user
gives is checked against it; the proviso allows up to 20 km/h less. Roads inside
housing estates take the LH ceiling of 20 km/h. Urban areas also settle the maximum
superelevation. The uses and conditions are written to the alignment's Description,
for example "용도: 도로, 관망 / 기준: LH_설계지침_토목 / 도로 구분: 집산도로 / 지역:
도시지역 / 편경사 지역: 도시지역 / 최대편경사: 6%" (`server/src/civil/alignmentRecord.ts`).
Later checks read them (and say so in their notes), so nobody is asked again; the
profile check derives its road function and terrain from them. With 도로 the alignment is a Centerline laid
out to the criteria; otherwise it is a Utility alignment with curves only where asked.
The criteria checks read the Description and skip road checks, with a note, for an
alignment whose recorded uses do not include 도로. Alignments without "용도:" are
checked as before. Then:

1. `plan_alignment_from_polyline` (`server/src/design`) plans the layout in code
   without drawing anything. The polyline's vertices are the IPs. A polyline arc
   becomes the IP where its end tangents meet, with the arc's radius. For a road,
   each IP gets the smallest curve the criteria allow: the 제19조 radius, the
   제20조 curve length, and 제23조 spirals from 60 km/h. A radius the user asked for
   or a polyline arc is used instead and flagged if it is below the criteria.
   The plan lists each IP with its deflection, radius and why, the range that fits
   between its neighbours, tangent, and status. It also lists straights too short for
   the curves at both ends, and one creation option with an id.
2. The user changes radii ("IP2는 400"), the name, or the direction, and the plan
   is made again.
3. When the user agrees, `apply_drawing_change` creates the alignment
   (`alignment.create`, `plugin/Civil/AlignmentCreation.cs`): fixed lines from IP to
   IP, then a free curve or spiral-curve-spiral between each pair. It uses no site
   and the drawing's default alignment style, label set, and layer, and records the
   design speed. The polyline must still have the vertices the plan was made from.
   Everything is one UNDO group.
4. A road alignment is checked at once with `check_alignment_criteria`, and the
   answer says whether it passes. Superelevation is left to Civil 3D. Profiles,
   corridors, and offset alignments are not created yet.

**Criteria sets.** `server/knowledge-defaults/criteria` holds one JSON file per
document. `도로구조규칙.json` is the law; `law:fetch` checks every row against the
current law text, including the 제8조 design speed table. `LH_설계지침_토목.json`
(LH 설계지침(토목) 제3454호, 2025-11-26) has `"extends": "도로구조규칙"`: the LH manual
defers to the law for curve radius, curve length, superelevation, spirals, vertical
curves, and grades (its tables equal the law's), so only the LH-specific tables are
in the file. These are housing-estate road speed, intersection grades, gentle-slope
lengths, and corner curb radii, each with its page and clause. `loadCriteria` adds the
law's other tables, and citations then name their document ("LH 지침 8.1.3 나",
"도로구조규칙 제19조"). The LH tables are marked `reviewed: false` until a person
compares them with the PDF. Intersection and corner values are data only; no tool
compares them with the drawing yet.

To add a check: put its limits in a criteria table, read the drawing values with
`readSection` (`server/src/civil`), compare them with `ReportBuilder.compare`
(`server/src/criteria`), add a fix function for failures, and register the
function as a read-only MCP tool.

Shipped rules are installed once; `.installed` records each installed text's hash.
A copy nobody has edited is replaced when a later version ships a new text; edited or
deleted copies are left alone.

Rules marked `always: true` are added to the skill as the stable part of each
request. Other rule files are listed by their `description` and read through the
`read_knowledge_rule` MCP tool only when a question needs them. A new `.md` file
with a `description` line in its front matter is picked up without rebuilding.
Rules and the skill are read on every request, so edits apply to the next question.

**Drawing knowledge.** Each saved drawing has a file in `data\knowledge\drawings`,
named after the drawing. It lists facts confirmed for that drawing, such as
what a layer contains or a naming rule, each with its basis
(사용자 답변 or 도면 확인), evidence, time, and AI.

- Every palette request includes the drawing's current facts, so the AI neither
  asks for them again nor looks them up with tools. A fact stated by the user in
  the current question, or read from the current drawing, takes precedence.
- When an answer confirms something new, the AI ends its reply with a
  `<facts>` block, as the skill describes. The service removes that block from
  the displayed answer and appends the facts. Guesses and values that change with
  edits, such as counts and elevations, are not recorded; facts with hedged
  wording such as 보인다 or 추정 are dropped by the service. This text protocol
  works the same way for Claude, Codex, and Gemini.
- A corrected fact is appended as a new section, and the old section is marked
  `정정됨`. The service never rewrites other sections. You may edit or delete
  sections by hand; hand-written `## ` sections are also read.
- Unsaved drawings have no file path, so no knowledge is kept for them.

### Knowledge candidates

Drawing facts describe one drawing. A practice the user states that holds beyond it,
such as "반지름은 항상 10 m 단위로 올려", is not written as a rule by the AI. The AI
proposes it in the facts block with `"scope": "general"` (user-stated only), and the
service stores it as a candidate in `data\knowledge\candidates.json`
(`server/src/knowledge/candidateStore.ts`). Candidates are never put into a prompt.
In the palette, `/후보` lists the pending ones with numbers, and "1, 3 승인", "2 반려",
or "모두 승인" decides them; `/후보 승인 1` works at any time. The service answers
these commands without an AI (`server/src/workflows/candidateCommands.ts`).
Approved candidates are appended to the common rule `승인된_지식.md` (`always: true`),
so every later question follows them. A misunderstanding in one conversation
therefore never spreads to every drawing without a person's approval. The palette
notes "지식 후보 n건" under an answer that added some.

### Work log

Every palette turn is written to `data\logs\<date>\turns.jsonl`: the question,
the answer, the tools called, changes applied, fixes offered, facts and candidates
recorded, tokens, model, and time. Cached answers, `/compact`, `/후보`, and failures are
included. Every MCP tool call of a palette request is written to
`data\logs\<date>\tools.jsonl` with its arguments, time taken, and result
(`server/src/mcp/toolLog.ts`). The logs stay on this PC and are never put into a
prompt. They are for finding where answers fail, ask too much, or are slow, for
spotting repeated work worth automating, for re-running real questions after a
change, and for tracing what was done when. Log folders older than 30 days are
removed; de-identified copies go to the admin through Google Drive (see below).

### Answer reuse

`data\memory\answers.json` keeps recent answers. The same
question (normalizing whitespace while preserving numbers, signs, punctuation, and case) to the same AI on an unchanged
drawing is answered from it without an AI request. Each AI keeps its own
answers, because AIs can answer differently. The plug-in counts object
additions, changes, and deletions in each open drawing, so any edit makes earlier
answers unusable; restarting Civil 3D does too. Answers expire after seven days.
`POST /api/memory/clear` erases this memory but not the knowledge files.

The palette shows input, output, and cached tokens for the most recent question
and totals for questions sent through this local service since it started.
The totals exclude CLI activity outside this palette and Gemini login probes.
Claude also reports its CLI's estimated USD cost when available. For Codex,
**한도 새로고침** reads the account's available quota windows through the Codex
app-server and shows remaining percentages and local reset times. If the account
backend reports that ordinary usage is blocked, the palette shows that status.
For Claude, **한도 새로고침** uses Anthropic's Agent SDK `get_usage` control request
with the existing Claude Code login. It shows the same 5-hour and 7-day windows
without requiring a separate interactive session or a status-line setting.
The SDK labels this API experimental, so a future SDK upgrade may require an
adapter change. If the direct lookup fails and a recent optional status-line
snapshot exists, the service uses that snapshot. It never reads or stores Claude
credentials itself. Gemini does not expose a documented headless quota read;
use `/stats model` in Gemini for its interactive report.

If Civil 3D already loaded an earlier version of the DLL, restart Civil 3D
before loading the rebuilt DLL.

## Sharing through Google Drive and learning from other users

There is no server. Each install keeps a send folder in its own Google Drive
(Google Drive for Desktop), `MyCivil3DMcp-<install id>`, and puts its
de-identified records and knowledge candidates there. The user shares that
folder with the admin's mail as an editor (that is the request to join); the
admin adds a shortcut to it in their own drive (that is the approval). The
admin's service then finds the folder, checks and takes in the files, and writes
back what it took, the approved knowledge, and the published release
(`server/src/drive/`, `server/src/admin/`; layout in
[docs/데이터관리_설계.md](docs/데이터관리_설계.md) §6). The GitHub release zip
carries `team.json` with the admin's mail (repository variable `ADMIN_EMAIL`),
so an install from it needs no setup. Palette commands (answered without an AI):

| Command | What it does |
|---|---|
| `/중앙` | drive, send folder, whether the admin takes it, queued and blocked packages |
| `/중앙 신청 [admin mail]` | make the send folder and show how to share it |
| `/중앙 드라이브 <path>` | where "My Drive" is, if it is not found |
| `/중앙 끊기`, `/중앙 켜기`, `/중앙 동기화` | stop, resume, or sync now |
| `/중앙 관리자` | make this PC the admin |
| `/중앙 사용자`, `/중앙 배포 <version>` | admin: member folders (block), publish a GitHub release |
| `/검토`, then `1 승인` / `2 반려 <reason>`; `/검토 보고`; `/검토 사례` | review (admin only) |
| `/설정값` | settings in force and where they come from |

Every 10 minutes and shortly after each answer, the local service turns new log
lines into records built from allowed fields only, masks drawing names, paths,
mail addresses, user and PC names, checks the whole package again, and moves it
to the send folder. A package that fails the check stays in
`data\outbox\blocked`. The admin's PC checks every file once more when it takes
it in and refuses forged folders.

Learning works in two ways. Knowledge candidates from several installs are
grouped by content, so the reviewer sees how many installs stated the same
practice. Values the AI set in a drawing are read again later; when people on
several installs keep changing them the same way (for example radii to multiples
of 10), the server proposes the matching setting. Only what the reviewer
approves reaches installs, as `rules\중앙_지식.md` and central settings.
Settings (`server/src/knowledge/parameters.ts`) are what code reads directly,
such as the radius rounding step; this PC's approvals come before central ones.

## MCP stdio entry point and tests

From `server`, `npm run smoke` verifies the MCP initialize handshake and tool discovery;
`npm run smoke:service` verifies the local API and bridge flow with a fake plug-in.
`npm run smoke:usage` checks token and quota response parsing.
`npm run smoke:memory` checks answer reuse rules; `npm run smoke:knowledge` checks
drawing knowledge files, the facts block, and common rules.
`npm run test:design` runs the design calculations (polyline paths, alignment plans,
criteria checks, fixes, creation and recheck) against a fake Civil 3D and compares
every result with `scripts/fixtures/design-regression.json`. Run it after any change to
the calculations; after an intended change, `node scripts/design-regression.mjs --update`
rewrites the snapshot, and its git diff shows exactly what changed.
`npm run test:drive` runs an admin and simulated installs over one fake Google Drive
folder, and checks the whole data flow: de-identification (nothing private reaches the
drive), tracking of a person's change to an AI-created alignment, candidate grouping and
the setting proposal, review, central knowledge and settings reaching the other install,
refusal of bad and forged files, blocking, problem cases, a signed release reaching the
member folders, and clean-up of old logs.
`npm run test:tools` calls each tool through MCP against the same fake and fails when
a tool returns more text than its budget: tool output is the AI's context, so its size is
paid on every call. The plug-in leaves absent values out of its JSON, and fixes and plans
reach the AI without how they are applied (the stored copy keeps that). Each palette tool
call's output size is written to the work log (`outputChars`).

**Failures.** A tool that fails returns its error with a guide from
`server/src/errors/failureGuide.ts`: the kind of failure, what it means, what the user
can do, what the AI does next, and whether the drawing changed (`false`, or `unknown`
after a timeout or lost connection while editing). Every AI therefore explains the same
failure the same way and does not retry what cannot work. The kinds are old_plugin,
not_connected, timeout, disconnected, no_drawing, too_large, ambiguous_name,
fix_not_offered, fix_conflict, changed_since, manual_only, name_taken,
polyline_unusable, not_found, criteria_gap, civil_refused, and unexpected.
`test:tools` checks that each message the code raises gets its kind. Failures of the AI
CLI itself (not logged in, usage limit, no answer) reach the palette in Korean.
The MCP entry point is `node build/index.js`. Its tools are:

| Tool | Result |
| --- | --- |
| `get_active_drawing` | Active drawing, Model Space count, units, coordinate system, change revision |
| `get_drawing_summary` | The whole drawing in one call: objects by type and layer, alignments, profiles, surfaces, pipe networks (pipe and structure counts), corridors, sites and parcels, COGO points |
| `list_drawing_layers` | Paged layer inventory with visibility, lock state, object counts, and type counts |
| `list_drawing_objects` | Paged Model Space handles, types, and layers; optional exact layer filter |
| `get_drawing_object` | One Model Space or COGO point object by handle, with available geometry and bounds |
| `get_selection` | The objects the user has selected in the drawing now: every one counted by type and layer, up to 20 in detail with Civil names and polyline summaries |
| `capture_drawing` | A PNG of Model Space framed on given objects (or the whole drawing), rendered off screen without moving the user's view |
| `list_alignments` | Paged alignment summaries: type, layer, site, start and end station (raw and formatted), length, profile count |
| `get_alignment` | One alignment's overview: summary, settings, item count of each section, parts Civil 3D could not provide, its profiles, design speeds, and curves when there are 30 or fewer |
| `get_alignment_section` | One section of an alignment, optionally within a station range: curves, elements, key points, station equations, design speeds, superelevation, offset, related objects, or failed design checks |
| `get_profile` | One profile's overview: summary, settings (source surface, offset, design checks), highest and lowest points, item count of each section, and for design profiles its vertical curves and tangents when each has 30 or fewer |
| `get_profile_section` | One section of a profile, optionally within a station range: PVIs with sight distances, tangent grades, vertical curves (crest or sag, K, minimum K, high or low point), profile views, failed design checks, or elevations at given stations or intervals |
| `apply_drawing_change` | Apply one computed fix or alignment plan the user agreed to, by id, then re-run its check; a created alignment comes back with a capture of it and its polyline for the AI to look at; the only tool that changes the drawing |
| `check_alignment_criteria` | Alignment against design criteria (default 도로구조규칙): design speed, minimum curve radius, minimum curve length, spirals required and their length, maximum superelevation. Each item is pass, fail, review (within a proviso; a person decides), or n/a; notCovered lists what is never compared |
| `check_profile_criteria` | Design profiles against design criteria: minimum vertical curve K, required vertical curve length, maximum grade; with only an alignment, all its design profiles |
| `check_all_alignments` | Every alignment and its design profiles checked in one call: counts per alignment, missing conditions, first failures, totals (no fixes; use the single checks for those) |
| `pick_polyline` | Prompt the user on the command line to click one 2D polyline and wait up to 90 s; returns it, or cancelled or timeout |
| `list_polylines` | Paged 2D polylines with layer, vertex and arc counts, length, start and end points; optional layer filter |
| `plan_alignment_from_polyline` | Plan, in code, a road centerline (to the criteria) or another alignment along a polyline; returns IPs, radii, fitting ranges, overlaps, and a creation option id; draws nothing |
| `read_knowledge_rule` | One common rule file by name, or the list of rule files |

An alignment is read once per drawing revision and kept in the plug-in, so
paging through its sections does not read it again; profiles work the same way.
Values Civil 3D computes, such as deflection angles, tangent lengths, key
stations, K values, and high or low points, are read rather than recomputed.
Profile elevations are read from the live profile on each request.
Grades are returned in percent. Station text follows the drawing's station
settings and equations.

Object detail includes position for points, endpoints for lines, center and radius
for circles, and up to 100 vertices for 2D polylines. Bounds are returned when
Civil 3D provides them. Pagination limits each list request to 200 items.

## Drawing safety and change buttons

Every open database has an instance id and revision. Checks read one consistent
instance/revision; stored proposals expire after two days and are also bound to
criteria/rule/parameter content. Legacy proposals cannot be applied. Old cache
files are ignored; existing knowledge remains readable. Unsaved drawings have an
instance id but do not store persistent drawing knowledge.

Proposal cards show **적용하기** and **되돌리기**. Applying and undoing through these
buttons do not call an AI. Apply checks the conversation's proposal ids and the
current drawing; undo checks the original drawing and the post-apply revision
inside the Civil 3D command context. After a verified undo, Apply becomes available
again. If another edit occurred, undo is refused so the user's work is preserved.

Committed changes remain marked applied even if rechecking fails. Reports distinguish
`pass`, `fail`, `review`, `incomplete`, and `not_applicable`; omitted pass rows are
retained internally for assessment. Operation receipts prevent duplicate application
and allow recovery after a lost response. Unknown outcomes are never automatically
reapplied. Receipts are session scoped in the plug-in: after Civil 3D restarts, old
operations cannot be undone through these cards. The normal CAD undo history remains
available separately.

The send button becomes **중지** during AI chat. Cancellation terminates the owned
CLI/MCP process tree and reconciles pending CAD operation ids; committed edits keep
their change cards. Each AI execution uses its own settings directory, including
conversation summaries. Failed directory cleanup is reported to stderr.

Run `npm run test:safety` from `server` for drawing identity/revision, guarded button
APIs, undo/reapply, post-commit failures, uncertainty recovery, cache versions,
UTF-8 streaming, request isolation, and process tree cleanup. Fake tests do not
replace manual checks of WPF controls, CAD undo grouping, and API effects in Civil 3D.

## 배포 패키지

Civil 3D 2025용 번들 생성은 `scripts/package.ps1`을 사용합니다. Node·npm을 동봉하고,
운영 의존성과 파일 manifest를 검사한 뒤 `dist/`에 설치 zip과 SHA-256 파일만 만듭니다.
설치·업데이트·실패 복구·제거 방법과 현장 검증 범위는 [배포 설치 안내](docs/배포_설치.md)를 참고하세요.
