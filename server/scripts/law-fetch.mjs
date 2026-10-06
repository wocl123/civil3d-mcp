// Fetches the current 「도로의 구조ㆍ시설 기준에 관한 규칙」 from the law.go.kr Open API,
// writes its articles as rule files by topic, and checks the criteria tables against it.
//
//   npm run law:fetch
//
// The API key (OC) is read from %LOCALAPPDATA%\MyCivil3DMcp\law-api.json: {"oc": "..."}.
// Outputs, under data/knowledge (and the shipped copies under knowledge-defaults):
//   criteria/source/도로구조규칙_<시행일>.json  the full API response, kept as the source
//   criteria/source/도로구조규칙.meta.json     version of the last fetch, used to detect revisions
//   criteria/도로구조규칙.json                 criteria tables with the result of the source check
//   rules/설계기준_도로구조규칙_<주제>.md       article text by topic (overwritten on every fetch)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../build/paths.js";

const LAW_ID = "007080";
const LAW_NAME = "도로의 구조ㆍ시설 기준에 관한 규칙";
const SHORT = "도로구조규칙";
// Split by topic so a question reads only the articles it needs.
const TOPICS = [
  { name: "일반", articles: ["3", "8", "9", "47"],
    about: "도로의 기능별 구분, 지역 구분, 설계속도, 설계구간, 기존 도로 특례" },
  { name: "평면", articles: ["19", "20", "21", "22", "23"],
    about: "평면곡선 반지름, 평면곡선 길이, 편경사와 접속설치율, 확폭, 완화곡선·완화구간" },
  { name: "종단", articles: ["24", "25", "26", "27", "28"],
    about: "정지·앞지르기 시거, 종단경사, 오르막차로, 종단곡선 변화 비율·길이, 횡단경사" }
];
const OLD_RULES = ["설계기준_도로구조규칙.md"];

const here = dirname(fileURLToPath(import.meta.url));
const defaults = join(here, "..", "knowledge-defaults");
const knowledge = process.env.MY_CIVIL3D_KNOWLEDGE_DIR ?? join(dataDir(), "knowledge");
const sourceDir = join(knowledge, "criteria", "source");

async function apiKey() {
  const file = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp", "law-api.json");
  try {
    const oc = JSON.parse(await readFile(file, "utf8")).oc;
    if (typeof oc === "string" && oc.trim()) return oc.trim();
  } catch { /* Reported below. */ }
  throw new Error(`법령 API 키가 없습니다. ${file} 에 {"oc": "..."} 를 넣어 주세요.`);
}

async function api(oc, path, params) {
  const url = new URL(`https://www.law.go.kr/DRF/${path}`);
  url.search = new URLSearchParams({ OC: oc, type: "JSON", ...params }).toString();
  const response = await fetch(url);
  const text = await response.text();
  try { return JSON.parse(text); } catch {
    // Errors arrive as an HTML page; keep only its message and never print the key.
    const message = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll(oc, "***").trim().slice(0, 300);
    throw new Error(`법령 API 오류 (HTTP ${response.status}): ${message}`);
  }
}

const list = value => value === undefined ? [] : [].concat(value);
const date = yyyymmdd => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

async function write(relative, content) {
  for (const root of [knowledge, defaults]) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

// Tables come as box-drawing text on one line; restore one line per table row
// and put them in a code block so the columns stay readable.
function text(value) {
  const plain = String(value ?? "").replace(/<img[^>]*>/g, "").replace(/<\/img>/g, "").trim();
  return plain.replace(/┌[\s\S]*?┘/g, table => "\n```\n" + table
    .replace(/([┐┤┘])/g, "$1\n").replace(/│(?=[│├└])/g, "│\n").replace(/\n+/g, "\n")
    // Full border lines, column padding, and long border runs only cost tokens; the
    // partial borders that remain still show which rows share a merged cell.
    .split("\n").filter(line => !/^[┌┐└┘├┤┬┴┼─│\s]*$/.test(line)).join("\n")
    .replace(/ {2,}/g, " ").replace(/ *│ */g, "│").replace(/─+/g, "─").trim() + "\n```\n");
}

function article(unit) {
  const lines = [`### 제${unit.조문번호}조${unit.조문가지번호 ? `의${unit.조문가지번호}` : ""}(${unit.조문제목})`];
  const head = text(unit.조문내용).replace(/^제\d+조(의\d+)?\([^)]*\)\s*/, "");
  if (head) lines.push(head);
  for (const paragraph of list(unit.항)) {
    if (paragraph.항내용) lines.push(text(paragraph.항내용));
    for (const item of list(paragraph.호)) {
      lines.push("  " + text(item.호내용));
      for (const sub of list(item.목)) lines.push("    " + list(sub.목내용).map(text).join(" "));
    }
  }
  return lines.join("\n");
}

function ruleFile(info, topic, articles) {
  const effective = date(info.시행일자);
  return `---
description: ${SHORT}(국토교통부 「${LAW_NAME}」, ${effective} 시행) 원문 중 ${topic.about} 조문. 기준값의 조문 원문이나 비교 도구가 다루지 않는 기준을 확인할 때 읽는다.
---
# ${SHORT} 원문: ${topic.name}

npm run law:fetch가 법령 API에서 받아 만든 파일이다. 직접 고치지 않는다. 적용 방법은 설계기준 규칙을 따른다.
법령: ${LAW_NAME} (국토교통부령 제${Number(info.공포번호)}호, 공포 ${date(info.공포일자)}, 시행 ${effective}), 받은 날 ${new Date().toISOString().slice(0, 10)}

${articles.join("\n\n")}
`;
}

// Every criteria row keeps the source line it came from; it must still appear in
// the article it cites. A missing line means the law changed or the table is wrong.
function verify(set, articleText, effective) {
  const mismatches = [];
  for (const table of set.tables) {
    const no = /제(\d+)조/.exec(table.article)?.[1];
    const body = articleText.get(no) ?? "";
    for (const row of table.rows)
      if (!body.includes(row.source)) mismatches.push(`${table.article} ${table.title}: ${JSON.stringify(row.when)} "${row.source}"`);
  }
  return { status: mismatches.length ? "mismatch" : "matched", checkedAt: new Date().toISOString(), lawEffective: date(effective), mismatches };
}

const oc = await apiKey();
const search = await api(oc, "lawSearch.do", { target: "law", query: LAW_NAME });
const hit = list(search.LawSearch?.law).find(law => law.법령ID === LAW_ID && law.현행연혁코드 === "현행");
if (!hit) throw new Error(`현행 「${LAW_NAME}」을 찾지 못했습니다.`);

const full = await api(oc, "lawService.do", { target: "law", MST: hit.법령일련번호 });
const info = full.법령.기본정보;
const units = list(full.법령.조문?.조문단위).filter(unit => unit.조문여부 === "조문");
const articleText = new Map(units.map(unit => [unit.조문번호, article(unit)]));

await mkdir(sourceDir, { recursive: true });
const metaFile = join(sourceDir, `${SHORT}.meta.json`);
const previous = await readFile(metaFile, "utf8").then(JSON.parse).catch(() => undefined);
const meta = { lawId: LAW_ID, mst: hit.법령일련번호, effective: info.시행일자, promulgation: info.공포번호, fetchedAt: new Date().toISOString() };
await writeFile(join(sourceDir, `${SHORT}_${info.시행일자}.json`), JSON.stringify(full, null, 1), "utf8");
await writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");

for (const topic of TOPICS) {
  const articles = topic.articles.flatMap(no => units.filter(unit => unit.조문번호 === no)).map(article);
  const name = `설계기준_${SHORT}_${topic.name}.md`;
  const content = ruleFile(info, topic, articles);
  await write(join("rules", name), content);
  console.log(`${name}: 조문 ${articles.length}개, ${content.length}자`);
}
for (const old of OLD_RULES)
  for (const root of [knowledge, defaults]) await rm(join(root, "rules", old), { force: true });

// The criteria tables: the data copy if people edited it, otherwise the shipped one.
const criteriaName = join("criteria", `${SHORT}.json`);
const set = JSON.parse(await readFile(join(knowledge, criteriaName), "utf8").catch(() => readFile(join(defaults, criteriaName), "utf8")));
set.verification = verify(set, articleText, info.시행일자);
await write(criteriaName, JSON.stringify(set, null, 1) + "\n");

console.log(`${LAW_NAME}: 시행 ${date(info.시행일자)}, 제${Number(info.공포번호)}호`);
console.log(set.verification.status === "matched"
  ? `기준표 ${set.tables.length}개 ${set.tables.reduce((sum, table) => sum + table.rows.length, 0)}행: 원문과 일치`
  : `기준표 원문 불일치 ${set.verification.mismatches.length}건:\n  ${set.verification.mismatches.join("\n  ")}`);
if (!previous) console.log("처음 받았습니다.");
else if (previous.effective !== meta.effective || previous.mst !== meta.mst)
  console.log(`개정됨: ${date(previous.effective)} → ${date(meta.effective)}. 이 기준으로 검토한 결과는 다시 확인하세요.`);
else console.log("법령 변경 없음.");
