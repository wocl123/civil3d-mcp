const OPENING = "<facts";
// Lines held back at the start while it is unclear whether they are a self-note.
const MAX_HELD = 600;

// Some AIs begin an answer by talking to themselves despite the skill, as in
// "Next question is 지역. Record the criteria fact." A line mostly in English letters at
// the start of a Korean answer is such a note.
function isSelfNote(line: string): boolean {
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  const hangul = (line.match(/[가-힣]/g) ?? []).length;
  return /^[A-Za-z]/.test(line.trim()) && latin >= 15 && latin > 3 * hangul;
}

// Where the answer starts after leading self-note lines, or undefined while a line is
// still incomplete. Notes are dropped only when Korean text follows them.
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

// The answer without leading self-notes (unless nothing Korean would remain) and without
// fix ids such as "(fx-63b8b73948)": the ids go with the answer into the conversation
// separately, and the user agrees by number or title.
export function dropSelfNotes(answer: string): string {
  const start = answerStart(answer, true) ?? 0;
  const text = /[가-힣]/.test(answer.slice(start)) ? answer.slice(start).trimStart() : answer;
  return text.replace(/ ?[(（]?fx-[a-f\d]{10}[)）]?/g, "");
}

// Passes streamed answer text through, but holds back leading self-notes and the
// trailing <facts> block (and any partial "<fac…" at the end) so the palette never shows them.
export class FactsFilter {
  private text = "";
  private sent: number | undefined;

  push(delta: string): string {
    this.text += delta;
    if (this.sent === undefined) {
      this.sent = answerStart(this.text, false);
      if (this.sent === undefined) return "";
    }
    const block = this.text.indexOf(OPENING);
    let safe = block >= 0 ? block : this.text.length;
    if (block < 0)
      for (let size = Math.min(OPENING.length - 1, this.text.length); size > 0; size--)
        if (OPENING.startsWith(this.text.slice(-size))) { safe = this.text.length - size; break; }
    const out = this.text.slice(this.sent, Math.max(this.sent, safe));
    this.sent = Math.max(this.sent, safe);
    return out;
  }
}
