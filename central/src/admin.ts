// 보안 관리 명령. 중앙 서버 PC에서 실행한다(서버를 켠 채로 써도 바로 적용된다).
//   npm run admin -- installs                 등록된 설치(PC) 목록: 설치 ID, 등록일, 마지막 접속일
//   npm run admin -- revoke <설치 ID>         그 PC의 토큰을 무효로 한다(다시 쓰려면 가입키로 새로 등록해야 한다)
//   npm run admin -- rotate enroll            가입키를 새로 만든다(설치 묶음이 새면). 이미 등록된 PC는 그대로 쓴다.
//                                             새 설치 묶음을 만들어(release kit) 새로 설치할 사람에게 준다.
//   npm run admin -- rotate reviewer          검토자 키를 새로 만든다(검토자 PC에서 /중앙 검토자 <새 키>)
//   npm run admin -- fingerprint              HTTPS 인증서 지문(각 PC의 /중앙 연결, 설치 묶음에 쓰인다)
//   npm run admin -- cases [--status todo] [--out 파일.json]
//                                             문제 사례 내보내기(기본: 처리하기로 한 것). 개발자에게 넘겨 고칠 때 쓴다.
//                                             status: new(분류 전) · todo · done · discarded · all

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig } from "./config.js";
import { loadTls } from "./tls.js";
import { type CaseStatus, problemCases } from "./review.js";
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
} else if (command === "fingerprint") {
  const tls = loadTls();
  say(tls ? `HTTPS 인증서 지문: ${tls.fingerprint}` : "HTTPS 인증서가 없습니다(이 PC 안에서만 쓰는 설정). start-central.ps1 -AllowNetwork 로 만드세요.");
} else if (command === "cases") {
  const at = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const status = (at("--status") ?? "todo") as CaseStatus;
  if (!["new", "todo", "done", "discarded", "all"].includes(status)) fail("status는 new, todo, done, discarded, all 중 하나입니다.");
  const cases = problemCases(new Store(), status, 10000);
  const out = at("--out");
  if (out) {
    writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), status, cases }, null, 1), "utf8");
    say(`${status} 사례 ${cases.length}건을 ${out}에 썼습니다. (질문·답이 들어 있으니 팀 안에서만 다루세요)`);
  } else {
    for (const item of cases) say(`- ${item.at} [${item.signals.join(", ")}] ${item.triage?.category ?? ""} ${item.triage?.note ?? ""} · ${(item.question ?? "").slice(0, 60)}`);
    say(`${status} 사례 ${cases.length}건`);
  }
} else {
  fail("명령: installs | revoke <설치 ID> | rotate enroll | rotate reviewer | fingerprint | cases");
}
