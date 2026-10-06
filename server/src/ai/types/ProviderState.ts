// AI 상태: 확인 전(또는 세션 끝) / 사용 가능 / 설치 안 됨 / 로그인 안 됨.
export type ProviderState = "unchecked" | "ready" | "missing" | "unauthenticated";
