// 보안 관리 명령. 중앙 서버 PC에서 실행한다(서버를 켠 채로 써도 바로 적용된다).
//   npm run admin -- installs                 등록된 설치(PC) 목록: 설치 ID, 등록일, 마지막 접속일
//   npm run admin -- revoke <설치 ID>         그 PC의 토큰을 무효로 한다(다시 쓰려면 가입키로 새로 등록해야 한다)
//   npm run admin -- rotate enroll            가입키를 새로 만든다(설치 묶음이 새면). 이미 등록된 PC는 그대로 쓴다.
//                                             새 설치 묶음을 만들어(release kit) 새로 설치할 사람에게 준다.
//   npm run admin -- rotate reviewer          검토자 키를 새로 만든다(검토자 PC에서 /중앙 검토자 <새 키>)
//   npm run admin -- joins                    가입 신청 목록(가입키 없이 설치한 PC)
//   npm run admin -- approve <설치 ID> | reject <설치 ID>   가입 승인 / 거절 (팔레트 /중앙 가입 과 같다)
//   npm run admin -- fingerprint              HTTPS 인증서 지문(각 PC의 /중앙 연결, 설치 묶음에 쓰인다)
//   npm run admin -- cases [--status todo] [--out 파일.json | 파일.md]   (.md: AI에게 넘길 수정 요청서)
//                                             문제 사례 내보내기(기본: 처리하기로 한 것). 개발자에게 넘겨 고칠 때 쓴다.
//                                             status: new(분류 전) · todo · done · discarded · all

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig } from "./config.js";
import { loadTls } from "./tls.js";
import { type CaseStatus, problemCases } from "./review.js";
import { decideJoin, JoinError, pendingJoins } from "./joins.js";
import { Store } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const say = (text: string) => process.stdout.write(text + "\n");
const fail = (text: string): never => { process.stderr.write(text + "\n"); process.exit(1); };

function writeJson(file: string, value: unknown): void {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 1), { encoding: "utf8", mode: 0o600 });
  renameSync(file + ".tmp", file);
}

const installsFile = join(dataDir, "installs.json");
const readInstalls = (): Record<string, { installId: string; enrolledAt: string; lastSeen: string }> => {
  try { return JSON.parse(readFileSync(installsFile, "utf8")); } catch { return {}; }
};

if (command === "installs" || !command) {
  const rows = Object.values(readInstalls()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  say(rows.length ? `등록된 설치 ${rows.length}개` : "등록된 설치가 없습니다.");
  for (const row of rows) say(`- ${row.installId}  등록 ${row.enrolledAt}  마지막 접속 ${row.lastSeen}`);
} else if (command === "revoke") {
  const id = args[0] ?? fail("형식: revoke <설치 ID> (installs로 확인)");
  const installs = readInstalls();
  if (!installs[id]) fail(`등록되지 않은 설치 ID입니다: ${id}`);
  delete installs[id];
  writeJson(installsFile, installs);
  say(`${id}의 토큰을 무효로 했습니다. 그 PC는 더 이상 보내거나 받을 수 없습니다.`);
  say("가입키가 그 사람에게 있다면 rotate enroll 로 가입키도 바꾸세요.");
} else if (command === "rotate") {
  const which = args[0];
  if (which !== "enroll" && which !== "reviewer") fail("형식: rotate enroll | rotate reviewer");
  const config = loadConfig();
  const file = join(dataDir, "config.json");
  if (which === "enroll") {
    config.enrollKey = randomBytes(12).toString("hex");
    writeJson(file, config);
    say(`새 가입키: ${config.enrollKey}`);
    say("이미 등록된 PC는 그대로 씁니다. 새로 설치할 사람에게는 npm run release -- kit <폴더> 로 새 설치 묶음을 만들어 주세요.");
  } else {
    config.reviewerKey = randomBytes(24).toString("hex");
    writeJson(file, config);
    say(`새 검토자 키: ${config.reviewerKey}`);
    say("검토자 PC의 팔레트에서 /중앙 검토자 <새 키> 를 입력하세요. 예전 키는 바로 쓸 수 없습니다.");
  }
} else if (command === "joins") {
  const rows = pendingJoins(new Store());
  say(rows.length ? `가입 신청 ${rows.length}건` : "대기 중인 가입 신청이 없습니다.");
  for (const row of rows) say(`- ${row.installId}  ${row.computer ?? "?"} · ${row.user ?? "?"}  신청 ${row.requestedAt.slice(0, 16).replace("T", " ")}`);
  if (rows.length) say("승인: approve <설치 ID>   거절: reject <설치 ID>");
} else if (command === "approve" || command === "reject") {
  const id = args[0] ?? fail(`형식: ${command} <설치 ID> (joins로 확인)`);
  try {
    const row = decideJoin(new Store(), id, command);
    say(`${row.computer ?? id} · ${row.user ?? "?"}: ${command === "approve" ? "승인했습니다. 그 PC는 1분 안에 자동으로 연결됩니다." : "거절했습니다."}`);
  } catch (error) {
    fail(error instanceof JoinError ? error.message : String(error));
  }
} else if (command === "fingerprint") {
  const tls = loadTls();
  say(tls ? `HTTPS 인증서 지문: ${tls.fingerprint}` : "HTTPS 인증서가 없습니다(이 PC 안에서만 쓰는 설정). start-central.ps1 -AllowNetwork 로 만드세요.");
} else if (command === "cases") {
  const at = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const status = (at("--status") ?? "todo") as CaseStatus;
  if (!["new", "todo", "done", "discarded", "all"].includes(status)) fail("status는 new, todo, done, discarded, all 중 하나입니다.");
  const cases = problemCases(new Store(), status, 10000);
  const out = at("--out");
  if (out && out.toLowerCase().endsWith(".md")) {
    // AI(Claude Code 등)에게 바로 넘기는 수정 요청서. 저장소의 /fix-cases 명령이 이 파일을 읽는다.
    const name: Record<string, string> = { knowledge: "지식", code: "코드", ai: "AI", other: "기타" };
    const lines = [
      `# 수정 요청: 문제 사례 ${cases.length}건 (${new Date().toISOString().slice(0, 10)}, 상태 ${status})`,
      "",
      "사용자가 👎를 누르거나, 적용한 변경을 되돌렸거나, 실패한 질문들이다. 검토자가 분류하고 메모를 남겼다.",
      "질문·답의 <이름>, <파일>, <경로>는 가림 처리된 것이다(원래 도면 이름·경로).",
      "",
      "각 사례마다: 원인을 찾는다 → 코드나 지식(knowledge-defaults)을 고친다 → 같은 문제가 다시 나오지 않게 회귀 시험을 더한다",
      "(설계 계산은 server/scripts/design-regression.mjs, 도구 동작은 해당 시나리오) → 시험을 모두 돌린다.",
      "고칠 수 없거나 사용자 착오로 보이면 이유를 적는다. 끝나면 사례 번호별 결과를 표로 정리한다.",
      ""
    ];
    cases.forEach((item, index) => {
      lines.push(`## 사례 ${index + 1} · ${name[item.triage?.category ?? ""] ?? "분류 없음"} · ${item.signals.join(", ")}`);
      lines.push("", `- 키: \`${item.key}\``, `- 시각: ${item.at}, 버전 ${item.appVersion ?? "?"}, ${item.provider ?? "?"} ${item.model ?? ""}${item.errorKind ? `, 실패 ${item.errorKind}` : ""}`);
      if (item.triage?.note) lines.push(`- 검토자 메모: ${item.triage.note}`);
      if (item.tools.length) lines.push(`- 사용한 도구: ${[...new Set(item.tools)].join(", ")}`);
      lines.push("", "**질문**", "", "```text", item.question ?? "(내용 없음)", "```", "", "**답**", "", "```text", item.answer ?? "(내용 없음)", "```");
      if (item.feedback.length) lines.push("", "**사용자 의견**", "", ...item.feedback.map(text => `- ${text}`));
      if (item.changes.length) lines.push("", "**도면 변경**", "", ...item.changes.map(change => `- ${change.state}: ${change.title ?? ""} ${change.labels ?? ""}`));
      lines.push("");
    });
    writeFileSync(out, lines.join("\n"), "utf8");
    say(`${status} 사례 ${cases.length}건의 수정 요청서를 ${out}에 썼습니다. (질문·답이 들어 있으니 팀 안에서만 다루세요)`);
  } else if (out) {
    writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), status, cases }, null, 1), "utf8");
    say(`${status} 사례 ${cases.length}건을 ${out}에 썼습니다. (질문·답이 들어 있으니 팀 안에서만 다루세요)`);
  } else {
    for (const item of cases) say(`- ${item.at} [${item.signals.join(", ")}] ${item.triage?.category ?? ""} ${item.triage?.note ?? ""} · ${(item.question ?? "").slice(0, 60)}`);
    say(`${status} 사례 ${cases.length}건`);
  }
} else {
  fail("명령: installs | joins | approve <설치 ID> | reject <설치 ID> | revoke <설치 ID> | rotate enroll | rotate reviewer | fingerprint | cases");
}
