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
  }),
});

export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;
