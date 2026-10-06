// 실패 안내: 서비스와 플러그인이 낼 수 있는 실패마다, 무슨 뜻이고 무엇을 하면 되는지.
// 도구가 실패하면 오류와 함께 이 안내를 돌려준다. 그래서 어느 AI든 같은 실패를 같은 말로 설명하고,
// 다시 시도해도 되는지 안다. (오류 원문은 영어라 정규식도 영어 문구로 맞춘다.)
export type FailureGuide = {
  kind: string;          // 실패 종류 (예: timeout, not_found). 작업 기록과 통계에도 쓴다.
  meaning: string;       // 무슨 일이 있었는지 (사용자 말로)
  userAction: string;    // 사용자가 할 일. 없으면 ""
  next: string;          // AI가 다음에 할 일

  // 도면이 바뀌었는지. 실패한 편집은 트랜잭션째 되돌려지지만,
  // 시간 초과나 연결 끊김은 Civil 3D 안에서 끝까지 실행됐을 수도 있다("unknown").
  drawingChanged: false | "unknown";
};

const ASK_NOTHING = "";
const NO_RETRY = "같은 호출을 다시 하지 않는다.";

// mayHaveChanged: 이 실패면 도면이 바뀌었을 수도 있다.
type Guide = Omit<FailureGuide, "drawingChanged"> & { mayHaveChanged?: true };

// [오류 문구 정규식, 안내]. 위에서부터 처음 맞는 것을 쓴다.
const GUIDES: [RegExp, Guide][] = [
  [/Method not found|Unknown bridge method/, {
    kind: "old_plugin",
    meaning: "Civil 3D에 불러온 플러그인이 서버보다 옛 버전이라 이 기능이 없다.",
    userAction: "Civil 3D를 다시 시작하고 NETLOAD로 플러그인을 다시 불러온다.",
    next: `${NO_RETRY} 플러그인을 다시 불러온 뒤 다시 요청해 달라고 안내한다.`
  }],
  [/connection was not found|connection settings are invalid|ECONNREFUSED|플러그인 연결이 없습니다/, {
    kind: "not_connected",
    meaning: "Civil 3D 플러그인과 연결되어 있지 않다.",
    userAction: "Civil 3D가 켜져 있는지, 플러그인을 NETLOAD했는지 확인하고 MYC3DCONNECTION으로 연결 상태를 본다.",
    next: `${NO_RETRY} 도면을 읽지 못했다고 알리고 연결을 확인해 달라고 한다.`
  }],
  [/request timed out/, {
    kind: "timeout",
    meaning: "Civil 3D가 제때 응답하지 않았다. 다른 명령이 실행 중이거나 대화상자가 열려 있으면 그렇다.",
    userAction: "Civil 3D에서 실행 중인 명령을 ESC로 끝내고 열린 대화상자를 닫는다.",
    next: `${NO_RETRY} 정리한 뒤 다시 요청해 달라고 안내한다. 도면을 바꾸던 중이었으면 바뀌었는지 도면에서 확인해 달라고 한다.`,
    mayHaveChanged: true
  }],
  [/closed the connection|plugin is unavailable/, {
    kind: "disconnected",
    meaning: "작업 도중 Civil 3D와의 연결이 끊겼다. Civil 3D가 종료되었거나 멈췄을 수 있다.",
    userAction: "Civil 3D가 정상인지 확인한다. 다시 시작했다면 NETLOAD가 필요하다.",
    next: `${NO_RETRY} 연결이 끊겼다고 알린다. 도면을 바꾸던 중이었으면 바뀌었는지 도면에서 확인해 달라고 한다.`,
    mayHaveChanged: true
  }],
  [/No active drawing|Civil 3D document is unavailable/, {
    kind: "no_drawing",
    meaning: "열린 도면이 없거나 활성 도면이 Civil 3D 도면이 아니다.",
    userAction: "작업할 Civil 3D 도면을 열고 그 도면 창을 활성화한다.",
    next: `${NO_RETRY} 도면을 열어 달라고 한다.`
  }],
  [/response exceeded 2 MiB/, {
    kind: "too_large",
    meaning: "한 번에 읽으려는 정보가 너무 많다.",
    userAction: ASK_NOTHING,
    next: "limit을 줄이거나 측점 범위(fromStation, toStation)나 구간(section)을 좁혀 다시 읽는다."
  }],
  [/Several (alignments|profiles) are named/, {
    kind: "ambiguous_name",
    meaning: "같은 이름의 객체가 여럿 있다.",
    userAction: ASK_NOTHING,
    next: "오류에 나온 핸들 중 맞는 것을 골라 핸들로 다시 부른다. 어느 것인지 모르면 사용자에게 묻는다."
  }],
  [/not offered to the user|not found or has expired|Unknown fix id/, {
    kind: "fix_not_offered",
    meaning: "적용하려는 수정안이 이번 대화에서 보여 준 것이 아니거나 오래되어 사라졌다.",
    userAction: ASK_NOTHING,
    next: "같은 조건으로 검토나 계획을 다시 해서 수정안을 보여 주고 다시 묻는다. 값을 지어내 적용하지 않는다."
  }],
  [/cannot be applied:/, {
    kind: "fix_conflict",
    meaning: "이 수정안은 앞뒤 요소와 겹쳐 그대로는 적용할 수 없다.",
    userAction: ASK_NOTHING,
    next: "오류의 이유를 설명하고 다른 수정안이나 직접 수정을 제안한다."
  }],
  [/바뀌어 있어 적용하지 않았습니다|계획 뒤에 바뀌어/, {
    kind: "changed_since",
    meaning: "수정안이나 계획을 계산한 뒤 도면이 바뀌어 적용하지 않았다. 도면은 그대로다.",
    userAction: ASK_NOTHING,
    next: "바뀐 도면으로 다시 검토하거나 계획할지 묻는다."
  }],
  [/아직 자동으로 적용할 수 없습니다|plug-in cannot apply/, {
    kind: "manual_only",
    meaning: "이 변경은 아직 자동으로 적용할 수 없다.",
    userAction: "Civil 3D에서 직접 수정한다.",
    next: "바꿀 값을 정리해 직접 고치는 방법을 안내한다."
  }],
  [/이미 있어 만들지 않았습니다|같은 이름의 선형/, {
    kind: "name_taken",
    meaning: "같은 이름의 선형이 이미 있다.",
    userAction: ASK_NOTHING,
    next: "다른 이름을 물어 name을 바꿔 다시 계획한다."
  }],
  [/닫힌 폴리라인|2D 폴리라인으로만|거의 되돌아간다|반원 이상|100개 이하만|폴리라인 길이가 0/, {
    kind: "polyline_unusable",
    meaning: "이 폴리라인으로는 선형을 만들 수 없다.",
    userAction: "다른 폴리라인을 고르거나 폴리라인을 고친다.",
    next: "오류의 이유를 쉽게 설명하고 다른 폴리라인을 고를지 묻는다."
  }],
  [/was not found|찾지 못했습니다|has no design profile/, {
    kind: "not_found",
    meaning: "말한 객체를 도면에서 찾지 못했다. 지워졌거나 이름이 바뀌었을 수 있다.",
    userAction: ASK_NOTHING,
    next: "목록 도구로 이름을 확인해 다시 부른다. 비슷한 것이 없으면 사용자에게 묻는다."
  }],
  [/표에 .* 행이 없다|has no table|기준이 없다|Criteria ".*" was not found/, {
    kind: "criteria_gap",
    meaning: "선택한 기준표에 이 조건의 값이 없다.",
    userAction: ASK_NOTHING,
    next: "어느 조건이 표에 없는지 밝히고 다른 조건이나 기준을 고를지 묻는다."
  }],
  [/바꾸지 못했습니다|넣지 못했습니다|eLockViolation|eWasOpenFor|eInvalidInput|eNotApplicable/, {
    kind: "civil_refused",
    meaning: "Civil 3D가 이 변경을 받아들이지 않았다. 도면은 바뀌지 않았다.",
    userAction: "실행 중인 명령이 있으면 끝내고, 해당 요소에 고정 조건이 있는지 확인한다.",
    next: `${NO_RETRY} 오류의 내용을 쉽게 설명하고 직접 수정이나 다른 수정안을 제안한다.`
  }]
];

// 어느 정규식에도 맞지 않는 오류.
const UNKNOWN: Guide = {
  kind: "unexpected",
  meaning: "예상하지 못한 오류가 났다.",
  userAction: ASK_NOTHING,
  next: `${NO_RETRY} 오류 내용을 짧게 전하고, 계속되면 작업 기록(data\\logs)을 확인해 달라고 한다.`
};

// 오류 메시지 → 실패 안내.
export function failureGuide(message: string): FailureGuide {
  const { mayHaveChanged, ...guide } = GUIDES.find(([pattern]) => pattern.test(message))?.[1] ?? UNKNOWN;
  return { ...guide, drawingChanged: mayHaveChanged ? "unknown" : false };
}

// AI 자체의 실패. CLI의 영어 메시지 대신 팔레트에 보여 줄 한국어 문장.
const PALETTE_MESSAGES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^(\w+) account is not verified/, match =>
    `${match[1]} 로그인이 확인되지 않았습니다. 팔레트에서 그 AI를 다시 선택하거나 터미널에서 로그인해 주세요.`],
  [/usage limit|rate limit|quota|429/i, () => "AI 사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시도하거나 다른 AI를 선택해 주세요."],
  [/^(\w+) failed\. Check its account login/, match => `${match[1]} 실행에 실패했습니다. 로그인 상태를 확인해 주세요.`],
  [/returned no (final )?answer/, () => "AI가 답을 만들지 못했습니다. 다시 질문해 주세요."],
  [/timed out|ETIMEDOUT/, () => "AI 응답이 너무 오래 걸려 멈췄습니다. 질문을 나눠서 다시 해 주세요."]
];

// 팔레트에 보여 줄 오류 문장: 아는 실패면 한국어 안내 + (원문), 모르면 원문 그대로.
export function paletteMessage(message: string): string {
  for (const [pattern, text] of PALETTE_MESSAGES) {
    const match = pattern.exec(message);
    if (match) return `${text(match)}\n(${message})`;
  }
  return message;
}
