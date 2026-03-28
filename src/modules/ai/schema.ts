import { z } from "zod";

export const NodeTypeSchema = z.enum(["component", "service", "database", "external"]);

export const DiagnosisOutputSchema = z.object({
  architecture_name: z.string().describe("英語のアーキテクチャ名。例: Tennis-Centric Monolith"),
  description: z.string().describe("毒舌エンジニア先輩による日本語の人生解説（300〜500文字）"),
  scores: z.object({
    throughput:      z.number().min(0).max(100),
    deploy_freq:     z.number().min(0).max(100),
    fault_tolerance: z.number().min(0).max(100),
    observability:   z.number().min(0).max(100),
    tech_debt:       z.number().min(0).max(100),
    coupling:        z.number().min(0).max(100),
  }),
  diagram_data: z.object({
    nodes: z.array(z.object({
      id:       z.string(),
      type:     NodeTypeSchema,
      position: z.object({ x: z.number(), y: z.number() }),
      data:     z.object({
        label:       z.string(),
        description: z.string().optional(),
      }),
    })),
    edges: z.array(z.object({
      id:     z.string(),
      source: z.string(),
      target: z.string(),
      label:  z.string().optional(),
    })),
    overview: z.object({
      headline: z.string().describe("この人生システム全体がどんなアーキテクチャかを一文で要約"),
      composition: z.string().describe("主要なアーキテクチャ要素がどう結びついているかを一文で説明"),
    }),
    flows: z.array(z.object({
      id:      z.string().describe("アクセスフローの識別子"),
      access:  z.string().describe("アクセス名。例: Team Request, Incident Event"),
      summary: z.string().describe("このアクセスがどんな流れかを1文で要約した説明"),
      steps: z.array(z.object({
        node_id: z.string().describe("nodes 内で定義したノードIDを参照する"),
        title:   z.string().describe("そのステップで実行される処理の短い名前"),
        detail:  z.string().describe("そのステップで起きている人生イベントの説明"),
      })).min(3).max(6),
    })).min(1).max(3),
  }),
});

export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;
