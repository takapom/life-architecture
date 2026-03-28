import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { AIProvider } from "../interface";
import type { DiagnosisAIInput, DiagnosisResult } from "@/types";
import { DiagnosisOutputSchema } from "../schema";
import { DIAGNOSIS_SYSTEM_PROMPT } from "../prompts/diagnosis";

export class GeminiProvider implements AIProvider {
  async generateDiagnosis(
    input: DiagnosisAIInput
  ): Promise<Omit<DiagnosisResult, "id" | "diagnosis_id" | "created_at">> {
    const answersText = input.answers
      .map(
        (a, i) =>
          `Q${i + 1}. ${a.question}\n[${a.concept}]\nA: ${a.answer}`
      )
      .join("\n\n");

    const userPrompt = `フェーズ: ${input.phase_label}（${input.phase_type === "current" ? "現在" : "過去"}）

以下の8つの回答を元に、このユーザーの人生アーキテクチャを診断してください。

    ${answersText}`;

    const { object } = await generateObject({
      model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
      schema: DiagnosisOutputSchema,
      system: DIAGNOSIS_SYSTEM_PROMPT,
      prompt: userPrompt,
      maxRetries: 3,
    });

    return {
      architecture_name: object.architecture_name,
      description: object.description,
      scores: object.scores,
      diagram_data: object.diagram_data,
    };
  }
}
