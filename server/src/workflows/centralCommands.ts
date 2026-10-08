// 구글 드라이브 연결과 검토 팔레트 명령. AI 없이 서비스가 바로 답한다 (docs/데이터관리_설계.md §9).
//   /중앙                          상태
//   /중앙 신청 [관리자 메일]        이 PC의 보내기 폴더를 만들고 공유 방법을 안내한다(GitHub zip 설치면 자동)
//   /중앙 드라이브 <경로>|자동      구글 드라이브 "내 드라이브" 폴더를 직접 정하기 / 다시 찾기
//   /중앙 끊기, /중앙 켜기          보내기 멈춤 / 다시 시작 (기록은 계속 쌓인다)
//   /중앙 동기화                   지금 바로 동기화
//   관리자 PC
//   /중앙 관리자                   이 PC를 관리자로(공유받은 사용자 폴더에서 가져오고, 승인 지식·배포본을 넣어 준다)
//   /중앙 사용자 [<번호> 차단|해제]  사용자 폴더 목록 / 차단
//   /중앙 배포 [<버전> [필수]]      GitHub 릴리스를 받아 배포(필수: 그보다 낮은 버전은 업데이트 필수) · /중앙 배포 지우기 <버전>
//   /검토, 이어서 "1 승인" / "2 반려 사유", /검토 보고
//   /검토 사례 [할일|완료] · /검토 사례 <번호> [처리 <지식|코드|AI|기타> 메모 | 버림 메모 | 완료 버전 메모 | 취소]
//   /검토 사례 내보내기 [new|todo|done|all]   AI에게 넘길 수정 요청서(.md)
//   /검토 정리                     한 바퀴 정리: 분류 전·할 일 사례만 남기고 나머지 질문의 내용 삭제
//   /설정값                        지금 적용되는 설정값과 출처

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { install } from "../data/install.js";
import { driveSettings, loadSettings, saveSettings, validEmail, type DriveSettings } from "../data/settings.js";
import { PARAMETERS, isParameterKey, parameterSummary } from "../knowledge/parameters.js";
import { adminDir, loadAdminConfig } from "../admin/adminConfig.js";
import { adminStore } from "../admin/adminStore.js";
import { current, fetchRelease, listReleases, publish, readRelease, ReleaseError, removeRelease } from "../admin/releases.js";
import { type CaseStatus, casesMarkdown, cleanupContent, decide, decideCase, problemCases as findCases, report as buildReport, ReviewError, reviewItems, type ReviewItem } from "../admin/review.js";
import { ensureMemberFolder, findDriveRoot, findMemberFolders } from "../drive/driveFolders.js";
import { memberStatus, NO_DRIVE } from "../drive/memberSync.js";
import { runSync, syncStatus, watch } from "../sync/syncLoop.js";
import { lastShown, parseDecision, pick, setShown } from "./shownLists.js";

const DRIVE_WEB = "https://drive.google.com/drive/my-drive";

// 이 명령들 중 하나면 답 글을, 아니면 undefined(→ 다음 명령 처리기나 AI로).
export async function centralCommand(question: string, conversation?: string): Promise<string | undefined> {
  const text = question.trim();
  if (text === "/설정값") return parametersText();
  if (/^\/중앙(\s|$)/.test(text)) return central(text.replace(/^\/중앙\s*/, ""), conversation);
  if (text === "/검토") return reviewList(conversation);
  if (text === "/검토 보고") return report();
  if (/^\/검토 사례(\s|$)/.test(text)) return problemCases(text.replace(/^\/검토 사례\s*/, ""), conversation);
  if (text === "/검토 정리") return cleanup();

  // "1 승인" 같은 답은 마지막 목록이 검토 목록일 때만 받는다.
  const listed = lastShown(conversation, "review");
  const reply = listed ? parseDecision(text) : undefined;
  return reply && listed ? reviewDecide(reply, listed, conversation) : undefined;
}

const failure = (error: unknown) => error instanceof ReviewError || error instanceof ReleaseError
  ? error.message : `오류: ${error instanceof Error ? error.message : String(error)}`;

// 설정을 바꿔 저장한다(팀 정보로 켜진 PC도 이때 settings.json에 남는다).
async function updateDrive(change: (drive: DriveSettings) => void): Promise<DriveSettings> {
  const settings = await loadSettings();
  const drive: DriveSettings = { ...(await driveSettings() ?? { enabled: true }), since: settings.drive?.since || new Date().toISOString() };
  change(drive);
  settings.drive = drive;
  await saveSettings(settings);
  return drive;
}

// 사용자에게 보여 줄 공유 안내.
const shareSteps = (folder: string, email?: string) => [
  `1. 구글 드라이브(${DRIVE_WEB})에서 **${folder}** 폴더를 우클릭 → 공유`,
  `2. ${email ? `**${email}**` : "관리자 메일"}을(를) **편집자**로 추가하고 보내기`,
  "3. 관리자가 받아 주면 그때부터 기록이 관리자에게 갑니다(따로 할 일 없음)."
].join("\n");

// /중앙 ... 처리.
async function central(rest: string, conversation?: string): Promise<string> {
  const [command, ...args] = rest.split(/\s+/).filter(Boolean);
  if (!command) return statusText();

  // ── 신청: 보내기 폴더를 만들고 공유 방법을 안내한다.
  if (command === "신청") {
    const email = args[0];
    if (email && !validEmail(email)) return "형식: /중앙 신청 [관리자 메일]\n예: /중앙 신청 admin@gmail.com";
    const drive = await updateDrive(item => { item.enabled = true; item.admin = false; if (email) item.adminEmail = email; });
    const root = findDriveRoot(drive.root);
    if (!root) return `${NO_DRIVE}\n설치하고 로그인한 뒤 /중앙 신청 을 다시 입력하세요.`;
    const folder = await ensureMemberFolder(root, (await install()).installId);
    void runSync();
    return [`구글 드라이브에 보내기 폴더를 만들었습니다: ${folder}`, "", "관리자에게 가입을 신청하려면:", shareSteps(folder.split(/[\\/]/).pop()!, drive.adminEmail)].join("\n");
  }

  // ── 드라이브 위치
  if (command === "드라이브") {
    const path = args.join(" ");
    if (!path) return "형식: /중앙 드라이브 <내 드라이브 폴더 경로> 또는 /중앙 드라이브 자동\n예: /중앙 드라이브 G:\\내 드라이브";
    if (path === "자동") {
      const drive = await updateDrive(item => { delete item.root; });
      const root = findDriveRoot(drive.root);
      return root ? `구글 드라이브를 찾았습니다: ${root}` : NO_DRIVE;
    }
    if (!findDriveRoot(path)) return `그 폴더가 없습니다: ${path}`;
    await updateDrive(item => { item.root = path; });
    void runSync();
    return `구글 드라이브 폴더를 ${path}(으)로 정했습니다.`;
  }

  // ── 관리자
  if (command === "관리자") {
    const drive = await updateDrive(item => { item.enabled = true; item.admin = true; });
    const root = findDriveRoot(drive.root);
    loadAdminConfig();
    void runSync().then(() => watch());
    return [
      "이 PC를 관리자로 정했습니다. 사용자 폴더에서 기록을 가져오고, 승인 지식과 배포 버전을 넣어 줍니다(10분마다, /중앙 동기화 로 바로).",
      root ? `- 구글 드라이브: ${root}` : `- ${NO_DRIVE}`,
      "",
      "사용자가 보내기 폴더를 공유하면 Gmail로 알림이 옵니다. 받아 주려면:",
      "drive.google.com → 공유 문서함 → 그 폴더 우클릭 → 정리 → **바로가기 추가** → 내 드라이브",
      "1분 안에 팔레트 아래 줄에 '새 사용자'가 보입니다(/중앙 사용자)."
    ].join("\n");
  }

  const drive = await driveSettings();
  if (!drive) return "구글 드라이브 연결을 아직 정하지 않았습니다. /중앙 신청 <관리자 메일> 을 입력하세요.";

  // ── 끊기 / 켜기
  if (command === "끊기") {
    await updateDrive(item => { item.enabled = false; });
    return "드라이브로 보내기를 멈췄습니다. 기록은 이 PC에 계속 쌓이고, /중앙 켜기로 다시 보낼 수 있습니다.";
  }
  if (command === "켜기") {
    await updateDrive(item => { item.enabled = true; });
    void runSync();
    return "드라이브로 보내기를 다시 시작했습니다.";
  }

  // ── 동기화
  if (command === "동기화") {
    const result = await runSync();
    if (result.error) return `동기화 중 문제가 있었습니다. ${result.error}`;
    if (drive.admin) return [
      `동기화했습니다. 사용자 ${result.members ?? 0}명, 가져온 묶음 ${result.sent}개, 후보 ${result.candidates}개, 중앙 지식 v${result.official ?? 0}.`,
      ...(result.problems?.length ? ["", "받지 않은 것:", ...result.problems.slice(0, 10).map(line => `- ${line}`)] : [])
    ].join("\n");
    return `동기화했습니다. 드라이브로 보낸 묶음 ${result.sent}개, 후보 ${result.candidates}개, 중앙 지식 v${result.official ?? 0}.`;
  }

  if (!drive.admin) return unknown();
  if (command === "사용자") return members(args, conversation, drive);
  if (command === "배포") return releases(args);
  return unknown();
}

const unknown = () => "알 수 없는 명령입니다. /중앙, /중앙 신청, /중앙 드라이브, /중앙 끊기, /중앙 켜기, /중앙 동기화 (관리자: /중앙 관리자, /중앙 사용자, /중앙 배포)를 쓸 수 있습니다.";
const when = (iso?: string) => iso ? new Date(iso).toLocaleString("ko-KR") : "없음";

// /중앙 : 연결 상태.
async function statusText(): Promise<string> {
  const [drive, { installId }, { state, pending, blocked }] = await Promise.all([driveSettings(), install(), syncStatus()]);
  const footer = [
    "",
    "보내는 것: 질문과 답, 도구 입력, 도면 변경 내용(적용·되돌림), 👎 의견, 시간·토큰·실패 종류, 사람이 AI 값을 고쳤는지, 지식 후보, 프로그램 버전.",
    "가려서 보내는 것: 도면 파일 이름, 경로, 메일, 사용자·PC 이름(<이름>, <경로> 등으로 바뀜). 도면 파일 자체는 보내지 않음."
  ];
  const common = [
    `- 익명 설치 ID: ${installId}`,
    `- 이 PC에 쌓인 묶음 ${pending}개, 검사에서 막힌 묶음 ${blocked}개${blocked ? " (data\\outbox\\blocked에 사유가 있습니다)" : ""}`,
    `- 마지막 보냄 ${when(state.lastPush)}, 마지막 받음 ${when(state.lastPull)}, 중앙 지식 v${state.officialVersion ?? 0}`,
    ...(state.lastError ? [`- 마지막 문제: ${state.lastError}`] : [])
  ];
  if (!drive) return ["### 구글 드라이브 연결", "- 연결 안 함 — /중앙 신청 <관리자 메일> 로 시작하세요.", ...common, ...footer].join("\n");

  if (drive.admin) {
    const store = adminStore();
    const rows = Object.values(store.members);
    const live = current();
    return [
      "### 구글 드라이브 연결 (관리자)",
      `- 드라이브: ${findDriveRoot(drive.root) ?? NO_DRIVE}${drive.enabled ? "" : " (멈춤)"}`,
      `- 사용자 ${rows.filter(row => !row.blocked).length}명${rows.some(row => row.blocked) ? `, 차단 ${rows.filter(row => row.blocked).length}명` : ""} → /중앙 사용자`,
      `- 받아 둔 기록 ${store.records.length}건, 후보 ${store.candidates.filter(row => row.status === "pending").length}건 대기 → /검토`,
      `- 배포 버전: ${live ? `${live.release.version}${live.minVersion ? ` (최소 ${live.minVersion})` : ""}` : "없음"} → /중앙 배포`,
      ...common
    ].join("\n");
  }

  const member = await memberStatus(drive);
  const admin = member.connected
    ? `연결됨 (마지막으로 가져감 ${when(member.lastTaken)})`
    : member.folder
      ? `아직 — 폴더를 관리자와 공유하세요.\n${shareSteps(member.name, drive.adminEmail)}`
      : "아직 — 보내기 폴더가 없습니다(다음 동기화 때 만듭니다).";
  return [
    "### 구글 드라이브 연결",
    `- 드라이브: ${member.root ?? NO_DRIVE}${drive.enabled ? "" : " (멈춤)"}`,
    `- 보내기 폴더: ${member.name}${member.folder ? `, 관리자를 기다리는 묶음 ${member.waiting}개` : ""}`,
    `- 관리자${drive.adminEmail ? `(${drive.adminEmail})` : ""}: ${admin}`,
    ...common,
    ...footer
  ].join("\n");
}

// /중앙 사용자 [<번호> 차단|해제]
async function members(args: string[], conversation: string | undefined, drive: DriveSettings): Promise<string> {
  const store = adminStore();
  if (!args.length) {
    const root = findDriveRoot(drive.root);
    if (!root) return NO_DRIVE;
    const own = (await install()).installId;
    for (const folder of await findMemberFolders(root)) {
      if (folder.installId === own || store.members[folder.installId]) continue;
      const today = new Date().toISOString().slice(0, 10);
      store.members[folder.installId] = { installId: folder.installId, folder: folder.name, firstSeen: today, lastSeen: today, seen: false };
    }
    const rows = Object.values(store.members).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    setShown(conversation, "members", rows.map(row => row.installId));
    const lines = rows.map((row, index) => `${index + 1}. ${row.folder} · 처음 ${row.firstSeen} · 마지막 ${row.lastSeen}${row.seen ? "" : " · **새 사용자**"}${row.blocked ? " · 차단됨" : ""}`);
    for (const row of rows) row.seen = true;
    store.saveMembers();
    void watch();
    return [
      `### 사용자 ${rows.length}명`,
      ...(lines.length ? lines : ["아직 없습니다."]),
      "",
      "누구의 폴더인지는 구글 드라이브에서 폴더 소유자로 보입니다.",
      "새 사용자 받기: 공유 알림 메일 → drive.google.com 공유 문서함 → 폴더 우클릭 → 정리 → 바로가기 추가 → 내 드라이브",
      "모르는 폴더면: /중앙 사용자 <번호> 차단 (그리고 드라이브에서 바로가기 삭제)"
    ].join("\n");
  }
  const match = /^(\d+)$/.exec(args[0]);
  const action = args[1];
  if (!match || (action !== "차단" && action !== "해제")) return "형식: /중앙 사용자 <번호> 차단|해제";
  const ids = lastShown(conversation, "members");
  if (!ids) return "먼저 /중앙 사용자 로 목록을 보세요.";
  const row = store.members[ids[Number(match[1]) - 1] ?? ""];
  if (!row) return `${match[1]}번이 목록에 없습니다.`;
  if (action === "차단") row.blocked = true; else delete row.blocked;
  store.saveMembers();
  return action === "차단"
    ? `${row.folder}: 차단했습니다. 이 폴더에서는 더 가져오지 않고 아무것도 넣어 주지 않습니다. 드라이브에서 바로가기도 지우세요.`
    : `${row.folder}: 차단을 풀었습니다.`;
}

// /중앙 배포 [<버전> [필수]] · /중앙 배포 지우기 <버전>
async function releases(args: string[]): Promise<string> {
  try {
    if (!args.length) {
      const live = current();
      const list = listReleases();
      return [
        "### 배포",
        `- 지금 배포 중: ${live ? `${live.release.version}${live.minVersion ? ` (최소 지원 ${live.minVersion})` : ""}, ${when(live.publishedAt)}` : "없음"}`,
        ...list.map(item => `- 받아 둠: ${item.version} · ${(item.size / 1048576).toFixed(1)} MB${item.tag ? ` · ${item.tag}` : ""}`),
        "",
        "새 버전 배포: 새버전내기.bat → GitHub 빌드가 끝나면 /중앙 배포 <버전> (예: /중앙 배포 0.1.3)",
        "사용자 PC는 6시간 안에(또는 Civil 3D를 다시 켤 때) 받아 두었다가 Civil 3D를 끄면 설치합니다."
      ].join("\n");
    }
    if (args[0] === "지우기") {
      if (!args[1]) return "형식: /중앙 배포 지우기 <버전>";
      const { stoppedPublishing } = removeRelease(args[1]);
      void runSync();
      return `지웠습니다: ${args[1]}${stoppedPublishing ? " (배포 중이던 버전이라 배포도 멈췄습니다)" : ""}`;
    }
    const version = args[0].replace(/^v/, "");
    const required = args[1] === "필수";
    const release = readRelease(version) ?? await fetchRelease(loadAdminConfig().githubRepo, version);
    publish(version, required ? version : undefined);
    const result = await runSync();
    return [
      `${release.version}을(를) 배포했습니다${required ? "(필수 업데이트)" : ""}. 서명과 SHA-256을 확인했습니다.`,
      `사용자 폴더 ${result.members ?? 0}곳에 넣었습니다. 각 PC는 6시간 안에 받아 두었다가 Civil 3D를 끄면 설치합니다.`,
      ...(result.error ? [`문제: ${result.error}`] : [])
    ].join("\n");
  } catch (error) {
    return `배포하지 못했습니다. ${failure(error)}`;
  }
}

// /설정값
async function parametersText(): Promise<string> {
  const list = await parameterSummary();
  return [
    "### 설정값",
    "승인된 관행 중 코드가 직접 쓰는 값입니다. 이 PC 승인 > 중앙 승인 > 기본값 순서입니다.",
    "",
    ...list.map(item => `- ${item.label}: **${item.value}** (${item.source})`)
  ].join("\n");
}

const supportText = (item: ReviewItem) => `${item.support.installs}개 설치 · ${item.support.cases}건`;
const parameterLabel = (parameter?: { key: string; value: number }) =>
  parameter && isParameterKey(parameter.key) ? `${PARAMETERS[parameter.key].label} = ${parameter.value}` : undefined;

// 관리자 PC인지.
const isAdmin = async () => (await driveSettings())?.admin === true;
const NOT_ADMIN = "관리자 PC가 아닙니다. 관리자라면 /중앙 관리자 를 먼저 입력하세요.";

// /검토 : 후보 묶음과 통계 제안을 번호와 함께.
async function reviewList(conversation?: string): Promise<string> {
  if (!await isAdmin()) return NOT_ADMIN;
  const store = adminStore();
  const items = reviewItems(store, loadAdminConfig());
  setShown(conversation, "review", items.map(item => item.id));
  if (!items.length) return `검토할 항목이 없습니다. 지금 중앙 지식은 v${store.official.version}, ${store.official.items.length}개입니다.`;
  return [
    `### 검토할 항목 ${items.length}개 (중앙 지식 v${store.official.version})`,
    "승인하면 다음 동기화(10분 이내) 때 사용자 폴더에 들어가고, 각 PC가 받아 적용합니다.",
    "",
    ...items.map((item, index) => [
      `${index + 1}. ${item.kind === "parameter" ? "[통계 제안] " : ""}**${item.content}**`,
      ...(parameterLabel(item.parameter) ? [`   - 설정값: ${parameterLabel(item.parameter)}`] : []),
      `   - 지지: ${supportText(item)}`,
      ...item.evidence.slice(0, 3).map(line => `   - ${line}`)
    ].join("\n")),
    "",
    "\"1 승인\", \"2 반려 사유\"처럼 답해 주세요. 반려에는 사유가 필요합니다."
  ].join("\n");
}

// "1 승인" / "2 반려 사유" 처리. 반려에는 사유가 필요하다.
async function reviewDecide(reply: NonNullable<ReturnType<typeof parseDecision>>, listed: string[], conversation?: string): Promise<string> {
  if (!await isAdmin()) return NOT_ADMIN;
  const ids = pick(reply.which, listed);
  if (!ids.length) return "번호를 찾지 못했습니다. /검토로 목록을 다시 봐 주세요.";
  if (reply.decision === "rejected" && !reply.reason) return "반려 사유를 함께 적어 주세요. 예: \"2 반려 회사마다 달라서\"";

  const store = adminStore();
  const config = loadAdminConfig();
  const lines: string[] = [];
  for (const id of ids) {
    try {
      lines.push(`- ${decide(store, config, { id, decision: reply.decision === "approved" ? "approve" : "reject", ...(reply.reason ? { reason: reply.reason } : {}) })}`);
    } catch (error) {
      lines.push(`- ${id}: ${failure(error)}`);
    }
  }
  // 결정한 항목은 목록에서 뺀다(남은 번호로 이어서 답할 수 있게). 승인했으면 바로 동기화해 나눠 준다.
  setShown(conversation, "review", listed.filter(id => !ids.includes(id)));
  if (reply.decision === "approved") await runSync();
  const head = `${reply.decision === "approved" ? "승인" : "반려"}했습니다 (중앙 지식 v${store.official.version}).`;
  return [head, "", ...lines].join("\n");
}

// /검토 보고 : 최근 기간의 실패·도구 통계와 수정 추적 결과.
async function report(): Promise<string> {
  if (!await isAdmin()) return NOT_ADMIN;
  const data = buildReport(adminStore(), loadAdminConfig());
  return [
    `### 최근 ${data.days}일 보고 (설치 ${data.installs}곳, 질문 ${data.turns}건)`,
    "",
    "**버전별** (설치 · 질문 · 실패율)",
    ...data.byVersion.map(item => `- ${item.version}: ${item.installs}곳 · ${item.turns}건 · ${item.failRate}%`),
    "",
    "**실패한 질문**",
    ...Object.entries(data.failedTurns).map(([kind, n]) => `- ${kind}: ${n}건`),
    "",
    "**도구** (호출 · 실패 · 평균 시간)",
    ...data.tools.map(item => `- ${item.tool}: ${item.calls} · ${item.failed} · ${item.avgMs} ms`),
    "",
    "**AI가 만든 값을 사람이 어떻게 했나**",
    ...Object.entries(data.kept).map(([property, outcomes]) =>
      `- ${property}: ${Object.entries(outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(", ")}`)
  ].join("\n");
}

// /검토 사례 : 결과가 이상했을 수 있는 질문(👎, 적용 후 되돌림, 변경 실패, 질문 실패). 검토자가 처리하거나 버린다.
const CATEGORY: Record<string, string> = { 지식: "knowledge", 코드: "code", ai: "ai", AI: "ai", 기타: "other" };
const CATEGORY_NAME: Record<string, string> = { knowledge: "지식", code: "코드", ai: "AI", other: "기타" };
const STATUS_NAME: Record<string, string> = { new: "분류 전", todo: "할 일", done: "완료" };

async function problemCases(rest: string, conversation?: string): Promise<string> {
  if (!await isAdmin()) return NOT_ADMIN;
  const store = adminStore();
  const short = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").slice(0, max);
  try {
    // 수정 요청서: /검토 사례 내보내기 [new|todo|done|all] (기본 todo)
    const exporting = /^내보내기(?:\s+(new|todo|done|discarded|all))?$/.exec(rest);
    if (exporting) {
      const status = (exporting[1] ?? "todo") as CaseStatus;
      const cases = findCases(store, status, 10000);
      const file = join(adminDir(), `수정요청-${new Date().toISOString().slice(0, 10)}.md`);
      await writeFile(file, casesMarkdown(cases, status), "utf8");
      return `${status} 사례 ${cases.length}건의 수정 요청서를 만들었습니다: ${file}\n(질문·답이 들어 있으니 팀 안에서만 다루세요. 저장소에서 /fix-cases <파일> 로 AI에게 넘깁니다.)`;
    }

    // 목록: /검토 사례, /검토 사례 할일, /검토 사례 완료
    const listOf = rest === "" ? "new" : rest === "할일" ? "todo" : rest === "완료" ? "done" : undefined;
    if (listOf) {
      const cases = findCases(store, listOf);
      setShown(conversation, "cases", cases.map(item => item.key));
      if (!cases.length) return `${STATUS_NAME[listOf]} 사례가 없습니다.`;
      return [
        `### 문제 사례 · ${STATUS_NAME[listOf]} ${cases.length}건`,
        ...cases.map((item, index) => {
          const triage = item.triage ? ` (${CATEGORY_NAME[item.triage.category ?? ""] ?? ""}${item.triage.version ? ` ${item.triage.version}` : ""}${item.triage.note ? `: ${short(item.triage.note, 40)}` : ""})` : "";
          return `${index + 1}. [${item.signals.join(", ")}] ${item.appVersion ?? "?"} · ${item.provider ?? "?"} · ${short(item.question, 60) || "(내용 없음)"}${triage}`;
        }),
        "",
        "자세히: /검토 사례 <번호> · 분류: /검토 사례 <번호> 처리 <지식|코드|AI|기타> [메모] · /검토 사례 <번호> 버림 [메모] · 요청서: /검토 사례 내보내기"
      ].join("\n");
    }

    // 번호: 바로 앞에 보여 준 사례 목록의 번호
    const match = /^(\d+)(?:\s+(처리|버림|완료|취소)(?:\s+(.*))?)?$/.exec(rest);
    if (!match) return "형식: /검토 사례 [할일|완료] · /검토 사례 <번호> [처리 <지식|코드|AI|기타> 메모 | 버림 메모 | 완료 버전 메모 | 취소] · /검토 사례 내보내기";
    const keys = lastShown(conversation, "cases");
    if (!keys) return "먼저 /검토 사례 로 목록을 보세요.";
    const key = keys[Number(match[1]) - 1];
    if (!key) return `${match[1]}번이 목록에 없습니다.`;

    if (!match[2]) {
      const item = findCases(store, "all", Number.MAX_SAFE_INTEGER).find(entry => entry.key === key);
      if (!item) return "사례를 찾지 못했습니다(이미 버렸을 수 있습니다).";
      return [
        `### 사례 ${match[1]} · ${item.signals.join(", ")}${item.triage ? ` · ${STATUS_NAME[item.triage.status] ?? item.triage.status} ${CATEGORY_NAME[item.triage.category ?? ""] ?? ""}` : ""}`,
        `${item.at} · 버전 ${item.appVersion ?? "?"} · ${item.provider ?? "?"} ${item.model ?? ""}${item.errorKind ? ` · 실패 ${item.errorKind}` : ""}`,
        "",
        "**질문**", item.question ?? "(내용 없음)",
        "",
        "**답**", item.answer ? item.answer.slice(0, 2000) : "(내용 없음)",
        ...(item.feedback.length ? ["", "**사용자 의견**", ...item.feedback.map(text => `- ${text}`)] : []),
        ...(item.changes.length ? ["", "**도면 변경**", ...item.changes.map(change => `- ${change.state}: ${change.title ?? ""} ${change.labels ?? ""}`)] : []),
        ...(item.tools.length ? ["", `**도구**: ${[...new Set(item.tools)].join(", ")}`] : []),
        ...(item.triage?.note ? ["", `**메모**: ${item.triage.note}`] : [])
      ].join("\n");
    }

    const words = (match[3] ?? "").trim();
    if (match[2] === "처리") {
      const [first, ...note] = words.split(/\s+/);
      const category = CATEGORY[first ?? ""];
      if (!category) return "분류를 붙여 주세요: /검토 사례 <번호> 처리 <지식|코드|AI|기타> [메모]";
      decideCase(store, { key, action: "todo", category, note: note.join(" ") });
      return `${match[1]}번을 할 일(${CATEGORY_NAME[category]})로 분류했습니다. /검토 사례 할일 로 모아 볼 수 있습니다.`;
    }
    if (match[2] === "버림") {
      decideCase(store, { key, action: "discard", note: words });
      return `${match[1]}번을 버렸습니다. 관리자 보관함에서 그 질문·답·의견 내용을 지웠습니다(통계 숫자만 남음).`;
    }
    if (match[2] === "완료") {
      const [first, ...note] = words.split(/\s+/);
      const version = /^\d+\.\d+\.\d+$/.test(first ?? "") ? first : undefined;
      decideCase(store, { key, action: "done", version, note: (version ? note : [first, ...note]).filter(Boolean).join(" ") });
      return `${match[1]}번을 완료로 표시했습니다${version ? `(${version}에서 고침)` : ""}. 그 내용은 지웠습니다(분류·메모·버전은 남음).`;
    }
    decideCase(store, { key, action: "reopen" });
    return `${match[1]}번의 분류를 취소했습니다(다시 분류 전).`;
  } catch (error) {
    return `문제 사례를 처리하지 못했습니다. ${failure(error)}`;
  }
}

// /검토 정리 : 재배포까지 끝낸 뒤 한 바퀴 정리. 분류 전·할 일 사례의 내용만 남긴다.
async function cleanup(): Promise<string> {
  if (!await isAdmin()) return NOT_ADMIN;
  const result = cleanupContent(adminStore());
  return `정리했습니다. 질문 ${result.scrubbed}건의 내용을 지웠습니다(숫자 통계는 남음). 분류 전·할 일 사례 ${result.kept}건은 그대로 두었습니다.`;
}
