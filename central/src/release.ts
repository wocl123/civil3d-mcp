// 배포 관리 명령. 중앙 서버 PC에서 실행한다(서버를 켠 채로 써도 된다).
//   npm run release -- list                       받아 둔 버전과 지금 배포 중인 버전
//   npm run release -- fetch [v0.2.0]             GitHub Release에서 받기(태그를 빼면 최신)
//   npm run release -- add <zip> [버전] [--unsigned]   인터넷이 없을 때: zip을 직접 넣기(옆의 .sig 필수, .sha256 있으면 검사)
//   npm run release -- publish <버전> [--min <버전>]   이 버전을 배포한다(설치 프로그램·팔레트가 받아 감)
//   npm run release -- remove <버전>              받아 둔 설치본 지우기(배포 중이면 배포도 멈춤)
//   npm run release -- kit <폴더> [--url <주소>]  사용자에게 줄 설치 묶음: 배포 zip + server.json(서버 주소, 가입키, 인증서 지문)
// GitHub 저장소와 토큰은 <dataDir>/config.json 의 githubRepo, githubToken(읽기 전용) 또는 환경 변수 GITHUB_TOKEN.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { host, loadConfig, port } from "./config.js";
import { loadTls, loopbackHost } from "./tls.js";
import { addRelease, current, fetchFromGitHub, listReleases, publish, releaseFile, ReleaseError, removeRelease, VERSION } from "./releases.js";

const config = loadConfig();
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const say = (text: string) => process.stdout.write(text + "\n");

// 다른 PC가 쓸 서버 주소(server.ts 시작 안내와 같은 규칙).
function serverUrl(): string {
  const scheme = loadTls() ? "https" : "http";
  if (host !== "0.0.0.0") return `${scheme}://${host}:${port}`;
  const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal);
  return `${scheme}://${address?.address ?? "127.0.0.1"}:${port}`;
}

async function main(): Promise<void> {
  if (command === "list" || !command) {
    const live = current();
    const releases = listReleases();
    say(live ? `배포 중: ${live.release.version}${live.minVersion ? ` (최소 지원 ${live.minVersion})` : ""}, 지정 ${live.publishedAt}` : "배포 중인 버전 없음");
    for (const item of releases)
      say(`- ${item.version}  ${(item.size / 1048576).toFixed(1)} MB  ${item.source}${item.tag ? ` ${item.tag}` : ""}  ${item.signed ? "서명됨" : "서명 없음"}  sha256 ${item.sha256.slice(0, 12)}…  받음 ${item.addedAt}`);
    if (!releases.length) say("받아 둔 설치본이 없습니다. fetch 또는 add로 받으세요.");
    return;
  }

  if (command === "fetch") {
    const repo = config.githubRepo;
    if (!repo) throw new ReleaseError(`config.json에 githubRepo(예: "owner/repo")를 넣어 주세요.`);
    const release = await fetchFromGitHub(repo, process.env.GITHUB_TOKEN ?? config.githubToken, args[0]);
    say(`받았습니다: ${release.version} (${release.tag}), sha256 ${release.sha256}`);
    say(`배포하려면: npm run release -- publish ${release.version}`);
    return;
  }

  if (command === "add") {
    const zip = args[0] && resolve(args[0]);
    if (!zip || !existsSync(zip)) throw new ReleaseError("형식: add <zip 경로> [버전]");
    const shaFile = zip + ".sha256";
    const expected = existsSync(shaFile) ? /^[a-f\d]{64}/i.exec(readFileSync(shaFile, "utf8").trim())?.[0] : undefined;
    const signature = existsSync(zip + ".sig") ? readFileSync(zip + ".sig", "ascii") : undefined;
    const release = await addRelease(zip, { version: args[1] && VERSION.test(args[1]) ? args[1] : undefined, expectedSha256: expected,
      signature, allowUnsigned: args.includes("--unsigned"), source: "file" });
    say(`넣었습니다: ${release.version}${expected ? " (.sha256 일치)" : " (.sha256 없음: 검사 안 함)"}${release.signed ? ", 서명 확인" : ", 서명 없음(시험용)"}`);
    say(`배포하려면: npm run release -- publish ${release.version}`);
    return;
  }

  if (command === "publish") {
    if (!args[0]) throw new ReleaseError("형식: publish <버전> [--min <버전>]");
    const state = publish(args[0], option("--min"));
    say(`배포를 시작했습니다: ${state.version}${state.minVersion ? `, 최소 지원 ${state.minVersion}` : ""}`);
    return;
  }

  if (command === "remove") {
    if (!args[0]) throw new ReleaseError("형식: remove <버전>");
    const { stoppedPublishing } = removeRelease(args[0]);
    say(`지웠습니다: ${args[0]}${stoppedPublishing ? " (배포 중이던 버전이라 배포도 멈췄습니다. 다른 버전을 publish 하세요)" : ""}`);
    return;
  }

  if (command === "kit") {
    const live = current();
    if (!live) throw new ReleaseError("배포 중인 버전이 없습니다. 먼저 publish 하세요.");
    if (!args[0]) throw new ReleaseError("형식: kit <폴더> [--url <서버 주소>]");
    const out = resolve(args[0]);
    mkdirSync(out, { recursive: true });
    const url = option("--url") ?? serverUrl();
    // 사용자 PC는 zip을 풀고 설치.bat을 누르면 된다. server.json이 있으면 설치할 때마다 서버에서 최신 버전을 확인한다.
    const kit = join(out, `MyCivil3DMcp-설치-${live.release.version}.zip`);
    copyFileSync(releaseFile(live.release), kit);
    const serverJson = join(out, "server.json");
    // HTTPS면 인증서 지문을 함께 넣는다. 설치 프로그램과 서비스는 이 지문의 인증서만 믿는다.
    // 다른 PC용 묶음은 HTTPS여야 한다(HTTP는 이 PC 안의 시험용 주소만).
    const tls = loadTls();
    const secure = url.startsWith("https:");
    if (secure && !tls) throw new ReleaseError("HTTPS 주소인데 인증서(<dataDir>/tls)가 없습니다. start-central.ps1로 서버를 시작해 만드세요.");
    if (!secure && !loopbackHost(new URL(url).hostname))
      throw new ReleaseError("다른 PC용 설치 묶음은 HTTPS 주소여야 합니다. start-central.ps1로 서버를 시작해 인증서를 만드세요.");
    writeFileSync(serverJson, JSON.stringify({ url, enrollKey: config.enrollKey, ...(secure ? { certSha256: tls!.fingerprint } : {}) }, null, 1) + "\n", "utf8");
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Compress-Archive -LiteralPath '${serverJson.replace(/'/g, "''")}' -DestinationPath '${kit.replace(/'/g, "''")}' -Update`], { stdio: "inherit" });
    say(`만들었습니다: ${kit}`);
    say(`  서버 ${url}, 버전 ${live.release.version}. 가입키가 들어 있으니 팀 안에서만 전달하세요.`);
    return;
  }

  throw new ReleaseError("알 수 없는 명령입니다. list, fetch, add, publish, remove, kit 중 하나를 쓰세요.");
}

main().catch(error => {
  process.stderr.write((error instanceof ReleaseError ? error.message : String(error)) + "\n");
  process.exit(1);
});
