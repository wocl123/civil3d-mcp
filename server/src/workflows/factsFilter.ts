// 답에서 사용자에게 보이면 안 되는 부분을 걸러 낸다.
//   - 답 첫머리에 AI가 혼잣말처럼 쓴 영어 메모 ("Next question is 지역. Record the criteria fact.")
//   - 답 끝의 <facts> 블록 (서비스가 따로 읽어 저장한다)
//   - 수정안 id "(fx-63b8b73948)" (id는 대화에만 따로 남기고, 사용자는 번호나 제목으로 동의한다)

const OPENING = "<facts";

// 혼잣말인지 아직 모를 때 붙잡아 두는 첫머리 글자 수.
const MAX_HELD = 600;

// 한국어 답의 첫머리에서 영어 글자가 대부분인 줄은 혼잣말 메모로 본다.
function isSelfNote(line: string): boolean {
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  const hangul = (line.match(/[가-힣]/g) ?? []).length;
  return /^[A-Za-z]/.test(line.trim()) && latin >= 15 && latin > 3 * hangul;
}

// 첫머리 혼잣말 줄들 다음, 진짜 답이 시작하는 위치.
// 아직 줄이 끝나지 않아 판단할 수 없으면 undefined(final이면 지금까지로 판단).
function answerStart(text: string, final: boolean): number | undefined {
  let at = 0;
  for (;;) {
    const end = text.indexOf("\n", at);
    if (end < 0) return final || text.length - at > MAX_HELD ? at : undefined;
    const line = text.slice(at, end);
    if (line.trim() && !isSelfNote(line)) return at;
    at = end + 1;
  }
}

// 다 된 답에서 첫머리 혼잣말과 수정안 id를 뺀다.
// 혼잣말을 빼면 한국어가 하나도 안 남는 경우에는 빼지 않는다.
export function dropSelfNotes(answer: string): string {
  const start = answerStart(answer, true) ?? 0;
  const text = /[가-힣]/.test(answer.slice(start)) ? answer.slice(start).trimStart() : answer;
  return text.replace(/ ?[(（]?fx-[a-f\d]{10}[)）]?/g, "");
}

// 실시간으로 오는 답 조각을 거른다.
// 첫머리 혼잣말과 끝의 <facts> 블록(그리고 끝에 걸쳐 있는 "<fac…" 조각)은 팔레트에 보내지 않는다.
export class FactsFilter {
  private text = "";
  private sent: number | undefined;   // 이미 보낸 위치(undefined면 아직 답 시작을 모름)

  push(delta: string): string {
    this.text += delta;

    // 답이 어디서 시작하는지 정해질 때까지 붙잡아 둔다.
    if (this.sent === undefined) {
      this.sent = answerStart(this.text, false);
      if (this.sent === undefined) return "";
    }

    // 보내도 되는 끝: <facts 앞까지. 끝이 "<fac"처럼 그 앞부분과 같으면 그 앞까지.
    const block = this.text.indexOf(OPENING);
    let safe = block >= 0 ? block : this.text.length;
    if (block < 0) {
      for (let size = Math.min(OPENING.length - 1, this.text.length); size > 0; size--) {
        if (OPENING.startsWith(this.text.slice(-size))) {
          safe = this.text.length - size;
          break;
        }
      }
    }

    const out = this.text.slice(this.sent, Math.max(this.sent, safe));
    this.sent = Math.max(this.sent, safe);
    return out;
  }
}
