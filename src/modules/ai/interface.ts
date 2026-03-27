import type { DiagnosisAIInput, DiagnosisResult } from "@/types";

export interface AIProvider {
  generateDiagnosis(
    input: DiagnosisAIInput
  ): Promise<Omit<DiagnosisResult, "id" | "diagnosis_id" | "created_at">>;
}
