// 도구 결과: 값을 JSON 문자열 하나로 돌려준다.
export function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
