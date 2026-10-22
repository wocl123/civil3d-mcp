// 레이어 계획. 상태와 삭제 객체는 미리 볼 때의 값으로 고정하고, 동의한 계획만 적용한다.
export type LayerState = { color: number; locked: boolean; frozen: boolean; off: boolean };
export type LayerDefinition = LayerState & { name: string };
export type LayerObjectTarget = { handle: string; type: string; layer: string };
export type LayerTarget = { name: string; handle: string; objects: LayerObjectTarget[] };
export type LayerEdit = { name: string; handle: string; before: LayerState; after: LayerState; changeColor: boolean };
export type LayerRequest = {
  action: "create" | "delete" | "edit";
  create: LayerDefinition[];
  targets: LayerTarget[];
  edits?: LayerEdit[];
  deleteObjects?: boolean;
  summary: string;
  details: string[];
};
