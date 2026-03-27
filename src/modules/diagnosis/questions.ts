import type { EnrichedAnswer } from "@/types";

export interface Question {
  id: number;
  question: string;
  concept: string;
}

export const QUESTIONS: Question[] = [
  {
    id: 1,
    question: "最近、一番時間とエネルギーを注いでることって何？",
    concept: "コアシステム / メインワークロード",
  },
  {
    id: 2,
    question: "人との関わり方を教えて。よく頼る人や頼られる場面ってある？",
    concept: "結合度 / 依存関係",
  },
  {
    id: 3,
    question: "予想外のことが起きたとき、どう動く？エピソードあれば。",
    concept: "耐障害性 / レジリエンス",
  },
  {
    id: 4,
    question: "「なんか変えたいな」「直さないとな」って思ってることある？",
    concept: "技術的負債",
  },
  {
    id: 5,
    question: "新しいことへの挑戦、どのくらいのペースでやってる？",
    concept: "デプロイ頻度 / 変化への適応",
  },
  {
    id: 6,
    question: "忙しさのピークが来たとき、どうやって乗り越えてる？",
    concept: "スケーラビリティ / 負荷耐性",
  },
  {
    id: 7,
    question: "自分の調子がいい・悪いって、どうやって気づく？",
    concept: "モニタリング / 自己観測",
  },
  {
    id: 8,
    question: "今の自分を直感で一言表すと？",
    concept: "セルフブランディング / ラベリング",
  },
];

export function enrichAnswers(
  answers: Record<string, string>
): EnrichedAnswer[] {
  return QUESTIONS.map((q) => ({
    question: q.question,
    concept: q.concept,
    answer: answers[String(q.id)] ?? "",
  }));
}
