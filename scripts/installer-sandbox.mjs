// 설치 EXE를 임시 폴더에 창 없이 설치해 본다(시험·배포 전 확인용).
// /Sandbox=1: Civil 3D 실행 확인과 "앱 및 기능" 등록을 건너뛰어 이 PC의 실제 설치를 건드리지 않는다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sandboxInstall(exe, root) {
  const bundle = join(root, 'plugins', 'MyCivil3DMcp.bundle');
  const data = join(root, 'data');
  const log = join(root, 'install.log');
  mkdirSync(root, { recursive: true });   // 로그 폴더가 없으면 Inno가 시작하지 못하고 1로 끝난다
  // 경로에 공백·한글이 있어도 되도록 Inno 문서의 형태(/이름="값") 그대로 넘긴다.
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/Sandbox=1', `/DIR="${bundle}"`, `/DataDir="${data}"`, `/LOG="${log}"`];
  const result = spawnSync(exe, args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 300000 });
  if (result.status !== 0) {
    const detail = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).slice(-20).join('\n') : '';
    throw new Error(`설치 EXE 시험 설치 실패(종료 코드 ${result.status}).\n${detail}`);
  }

  const teamFile = join(data, 'team.json');
  const team = existsSync(teamFile) ? JSON.parse(readFileSync(teamFile, 'utf8').replace(/^\s+/, '')) : undefined;
  return { bundle, data, team, uninstaller: join(root, 'plugins', 'MyCivil3DMcp.bundle.uninstall', 'unins000.exe') };
}
