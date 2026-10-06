const OPENING = "<facts";

// Passes streamed answer text through, but holds back the trailing <facts> block
// (and any partial "<fac…" at the end) so the palette never shows it.
export class FactsFilter {
  private text = "";
  private sent = 0;

  push(delta: string): string {
    this.text += delta;
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
