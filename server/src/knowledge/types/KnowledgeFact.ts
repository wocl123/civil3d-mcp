export type KnowledgeFact = {
  id: string;
  title: string;
  content: string;
  basis: "user_answer" | "drawing";
  evidence: string;
  replaced: boolean;
};
