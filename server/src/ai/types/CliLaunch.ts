// CLI 실행 설정: 작업 폴더, 추가 환경 변수, 명령 인자.
export type CliLaunch = { cwd: string; env: Record<string, string>; args: string[] };
