// 도면 지식 파일의 사실 하나.
export type KnowledgeFact = {
  id: string;                          // F-20261006-1 (사람이 쓴 절은 M-번호)
  title: string;
  content: string;
  basis: "user_answer" | "drawing";    // 사용자가 말해 줌 / 도면에서 확인함
  evidence: string;
  replaced: boolean;                   // 다른 사실이 고쳐서 "정정됨"
};
