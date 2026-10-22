import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { terminateTree } from "../ai/processTree.js";
import { longAdminJob, type AdminJob } from "./jobTypes.js";

type Active = { id: number; reject: (error: Error) => void; timer: NodeJS.Timeout };
type WorkerOptions = { file?: string; timeoutMs?: number; syncTimeoutMs?: number };

const timeout = (value: string | undefined, fallback: number) =>
  Math.max(1000, Math.min(600000, Number(value) || fallback));

// Promise.race만 쓰고 대기열을 풀면 시간 초과한 작업이 뒤에서 계속 파일을 바꾼다.
// 작업 프로세스 종료까지 확인한 뒤에만 다음 작업을 받는다. 실패한 작업은 자동 재실행하지 않는다.
export class AdminWorker {
  private child?: ChildProcess;
  private active?: Active;
  private sequence = 0;
  private poisoned = false;
  private stopping?: Promise<void>;
  private closed?: Promise<void>;
  private stderr = "";

  constructor(private readonly options: WorkerOptions = {}) {}

  get busy(): boolean {
    return this.active !== undefined || this.stopping !== undefined;
  }

  async request<T extends string | number>(job: AdminJob): Promise<T> {
    if (this.stopping) {
      await this.stopping;
    }

    if (this.busy || this.poisoned) {
      throw new Error("이전 관리자 작업이 정리 중입니다. 잠시 뒤 다시 시도하거나 관리자 창을 다시 열어 주세요.");
    }

    const child = this.child ?? this.start();
    const id = ++this.sequence;
    const limit = longAdminJob(job)
      ? this.options.syncTimeoutMs ?? timeout(process.env.MY_CIVIL3D_ADMIN_SYNC_TIMEOUT_MS, 120000)
      : this.options.timeoutMs ?? timeout(process.env.MY_CIVIL3D_ADMIN_TIMEOUT_MS, 20000);
    return this.exchange<T>(child, job, id, limit);
  }

  private exchange<T>(child: ChildProcess, job: AdminJob, id: number, limit: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fail = this.listen(child, id, resolve, reject);
      const timer = setTimeout(() => {
        void this.cancel(`작업이 ${Math.round(limit / 1000)}초 안에 끝나지 않아 중단했습니다.`);
      }, limit);
      this.active = { id, reject: fail, timer };
      child.send({ id, job }, error => {
        if (error && this.active?.id === id) {
          void this.cancel("작업 요청을 전달하지 못했습니다.");
        }
      });
    });
  }

  private listen<T>(child: ChildProcess, id: number, resolve: (value: T) => void, reject: (error: Error) => void) {
    const finish = (error?: Error, value?: T) => {
      this.release();
      child.off("message", onMessage);
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };

    const onMessage = (message: { id?: number; value?: T; error?: string }) => {
      if (message.id !== id || this.active?.id !== id || this.stopping) {
        return;
      }

      finish(message.error ? new Error(message.error) : undefined, message.value);
    };

    child.on("message", onMessage);
    return (error: Error) => finish(error);
  }

  async cancel(reason = "작업을 취소했습니다."): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }

    this.stopping = this.stop(reason).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stop(reason: string): Promise<void> {
    const active = this.active;
    if (active) {
      clearTimeout(active.timer);
    }

    const child = this.child;
    if (child) {
      await terminateTree(child);
      const expired = delay(2000, undefined, { ref: false }).then(() => false);
      const ended = await Promise.race([this.closed!.then(() => true), expired]);
      this.poisoned = !ended;
      if (ended) {
        this.child = undefined;
      }
    }

    this.release();
    active?.reject(new Error(reason + " 저장·가져오기 결과는 목록에서 확인해 주세요. 자동으로 다시 실행하지 않습니다."));
  }

  private release(): void {
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active = undefined;
    }
  }

  private start(): ChildProcess {
    const file = this.options.file ?? fileURLToPath(new URL("./worker.js", import.meta.url));
    const child = spawn(process.execPath, [file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.child = child;
    this.stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    this.closed = new Promise(resolve => child.once("close", () => resolve()));
    child.once("error", () => {
      void this.cancel("관리자 작업 프로세스를 시작하지 못했습니다.");
    });
    child.once("close", () => {
      if (!this.stopping) {
        const reject = this.active?.reject;
        this.release();
        this.child = undefined;
        reject?.(new Error("관리자 작업이 예기치 않게 끝났습니다. " + this.stderr.trim()));
      }
    });
    return child;
  }
}
