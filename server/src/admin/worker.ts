import type { AdminJob } from "./jobs.js";

// 먼저 수신기를 등록한다. 설정·보관함 로딩이 늦어져도 첫 요청을 잃지 않는다.
const jobs = import("./jobs.js");
let running = false;
process.on("disconnect", () => process.exit(0));
process.on("message", async (request: { id: number; job: AdminJob }) => {
  if (running) {
    process.send?.({ id: request.id, error: "이미 관리자 작업이 실행 중입니다." });
    return;
  }

  running = true;
  try {
    const { executeAdminJob } = await jobs;
    process.send?.({ id: request.id, value: await executeAdminJob(request.job) });
  } catch (error) {
    process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
});
