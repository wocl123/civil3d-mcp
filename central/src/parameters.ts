// 설치가 아는 설정값 목록 (server/src/knowledge/parameters.ts 와 같아야 한다).
// 키, 허용 값, 그리고 사람의 수정 기록에서 이 설정값을 보여 주는 속성(observe).

export const PARAMETERS: Record<string, { label: string; allowed: number[]; observe: string }> = {
  "alignment.radiusStep": {
    label: "평면곡선 반지름 올림 단위(m)", allowed: [1, 5, 10, 50, 100], observe: "alignment.radius"
  },
  "alignment.spiralStep": {
    label: "완화곡선 길이 올림 단위(m)", allowed: [1, 5, 10], observe: "alignment.spiralLength"
  },
  "profile.curveLengthStep": {
    label: "종단곡선 길이 올림 단위(m)", allowed: [1, 5, 10, 20], observe: "profile.curveLength"
  }
};

// { key, value } 가 있는 키이고 허용 값이면 받는다.
export function validParameter(value: unknown): { key: string; value: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.key !== "string" || !(item.key in PARAMETERS) || typeof item.value !== "number") return undefined;
  return PARAMETERS[item.key].allowed.includes(item.value) ? { key: item.key, value: item.value } : undefined;
}
