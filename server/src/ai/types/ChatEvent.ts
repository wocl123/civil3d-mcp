// AI가 답을 만드는 동안의 진행 상황: 부른 도구, 또는 도착한 답 글자.
export type ChatEvent = { type: "tool"; name: string } | { type: "text"; text: string };
