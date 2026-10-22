import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");

function cellWidth(char: string): number {
  if (/\p{Mark}|\u200D/u.test(char)) {
    return 0;
  }

  const code = char.codePointAt(0)!;
  const wide = code >= 0x1100 && (code <= 0x115F || code >= 0x2E80 && code <= 0xA4CF
    || code >= 0xAC00 && code <= 0xD7A3 || code >= 0xF900 && code <= 0xFAFF
    || code >= 0xFE10 && code <= 0xFE6F || code >= 0xFF00 && code <= 0xFF60
    || code >= 0x1F300 && code <= 0x1FAFF || code >= 0x20000);
  return wide ? 2 : 1;
}

export function wrapTerminal(text: string, width: number): string[] {
  return clean(text).split("\n").flatMap(line => {
    const rows: string[] = [];
    let current = "", length = 0;
    for (const char of line.replace(/\t/g, "    ")) {
      const cells = cellWidth(char);
      if (length + cells > width && current) {
        rows.push(current);
        current = "";
        length = 0;
      }

      current += char;
      length += cells;
    }

    rows.push(current);
    return rows;
  });
}

type Page = { title: string; body: string; prompt: string; home: boolean; index: number };
type Work = { label: string; startedAt: number; limit: number };

export class AdminTerminal {
  readonly interactive = stdin.isTTY === true && stdout.isTTY === true;
  private readonly input: Interface;
  private readonly queued: string[] = [];
  private pending?: (line: string | undefined) => void;
  private ended = false;
  private pageState?: Page = { title: "시작", body: "관리자 메뉴를 준비하고 있습니다.", prompt: "", home: false, index: 0 };
  private notification = "";
  private workState?: Work;
  private clock?: NodeJS.Timeout;
  lastActivity = Date.now();
  onCancel: () => void = () => {};

  constructor() {
    this.input = createInterface({ input: stdin, output: stdout, terminal: this.interactive });
    this.input.on("line", line => this.receive(line));
    this.input.on("close", () => {
      this.ended = true;
      this.receive(undefined);
    });
    this.input.on("SIGINT", () => {
      if (this.workState) {
        this.onCancel();
      } else {
        this.close();
      }
    });
    if (this.interactive) {
      emitKeypressEvents(stdin);
      stdin.on("keypress", this.onKey);
      stdout.on("resize", this.onResize);
    }
  }

  get idleHome(): boolean {
    return this.pageState?.home === true && this.pending !== undefined && !this.input.line.trim();
  }

  private readonly onKey = (_text: string, key?: { name?: string }) => {
    this.lastActivity = Date.now();
    if (key?.name === "escape") {
      this.input.write(null, { ctrl: true, name: "u" });
      if (this.workState) {
        this.onCancel();
      } else {
        this.receive("\x1b");
      }
    }
  };

  private readonly onResize = () => this.redraw();

  private receive(line: string | undefined): void {
    this.lastActivity = Date.now();
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve(line);
    } else if (!this.interactive && line !== undefined) {
      this.queued.push(line);
    }
  }

  async ask(prompt: string): Promise<string | undefined> {
    this.input.setPrompt(prompt);
    this.input.prompt();
    if (this.queued.length) {
      return this.queued.shift();
    }

    if (this.ended) {
      return undefined;
    }

    return await new Promise(resolve => {
      this.pending = resolve;
    });
  }

  async page(title: string, body: string, prompt: string, home = false): Promise<string | undefined> {
    this.pageState = { title, body, prompt, home, index: 0 };
    while (true) {
      const total = this.render();
      const line = (await this.ask(prompt))?.trim();
      const answer = line === "\x1b" ? "b" : line;
      if (answer?.toLowerCase() === "n") {
        this.pageState.index = Math.min(this.pageState.index + 1, total - 1);
      } else if (answer?.toLowerCase() === "p") {
        this.pageState.index = Math.max(this.pageState.index - 1, 0);
      } else {
        return answer;
      }
    }
  }

  notice(text: string): void {
    this.notification = clean(text);
    if (this.interactive) {
      this.redraw();
    } else {
      stdout.write(text + "\n");
    }
  }

  work(label?: string, limit = 0): void {
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }

    this.workState = label ? { label, limit, startedAt: Date.now() } : undefined;
    if (this.interactive) {
      if (!label && !this.pending) {
        this.input.write(null, { ctrl: true, name: "u" });
      }

      this.redraw();
      if (label) {
        this.clock = setInterval(() => this.redraw(), 250);
      }
    } else if (label) {
      stdout.write(`[작업] ${label}\n`);
    }
  }

  private redraw(): void {
    this.render();
    if (this.pending) {
      this.input.prompt(true);
    }
  }

  private render(): number {
    const page = this.pageState;
    if (!page) {
      return 1;
    }

    if (!this.interactive) {
      stdout.write(`\n=== ${page.title} ===\n${page.body}\n`);
      return 1;
    }

    const width = Math.max(20, (stdout.columns || 100) - 2);
    const height = Math.max(3, (stdout.rows || 32) - 10);
    const rows = wrapTerminal(page.body, width);
    const total = Math.max(1, Math.ceil(rows.length / height));
    page.index = Math.min(page.index, total - 1);
    const body = rows.slice(page.index * height, (page.index + 1) * height);
    const status = this.workState;
    const elapsed = status ? Math.floor((Date.now() - status.startedAt) / 1000) : 0;
    const progress = status ? `${status.label} · ${elapsed}초 / 최대 ${Math.ceil(status.limit / 1000)}초` : "";
    const hint = status ? "Esc/Ctrl+C: 작업 중단" : "Esc/0: 이전 메뉴 · q: 종료";
    const banner = this.notification ? wrapTerminal("최근 작업: " + this.notification, width)[0]
      : "설정과 검토 결과는 이 PC에 보관됩니다.";
    stdout.write("\x1b[2J\x1b[H" + [
      wrapTerminal("My Civil 3D MCP 관리자", width)[0], wrapTerminal(page.title, width)[0], banner,
      "─".repeat(Math.min(width, 70)), ...body, "",
      total > 1 ? `페이지 ${page.index + 1}/${total} · n: 다음 · p: 이전` : "",
      wrapTerminal(progress, width)[0], wrapTerminal(hint, width)[0], ""
    ].join("\n"));
    return total;
  }

  close(): void {
    if (this.clock) {
      clearInterval(this.clock);
    }

    stdin.off("keypress", this.onKey);
    stdout.off("resize", this.onResize);
    this.input.close();
  }
}
