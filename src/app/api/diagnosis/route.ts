import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { enrichAnswers } from "@/modules/diagnosis/questions";
import { GeminiProvider } from "@/modules/ai/providers/gemini";
import type { DiagnosisAIInput } from "@/types";

const aiProvider = new GeminiProvider();

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
}

async function callAI(input: DiagnosisAIInput) {
  try {
    return await aiProvider.generateDiagnosis(input);
  } catch (err) {
    if (isQuotaError(err)) {
      throw Object.assign(new Error("AI quota exceeded"), { code: "AI_QUOTA_EXCEEDED" });
    }
    throw err;
  }
}

const AnswersSchema = z.record(
  z.string().regex(/^[1-8]$/),
  z.string().min(1, "回答は必須です").max(1000, "回答は1000文字以内にしてください")
).refine(
  (obj) => Object.keys(obj).length === 8,
  "8問すべての回答が必要です"
);

const RequestSchema = z.object({
  submission_id:       z.string().uuid("submission_id は UUID である必要があります"),
  answers:             AnswersSchema,
  phase_label:         z.string().min(1).max(50),
  phase_type:          z.enum(["current", "past"]),
  paired_diagnosis_id: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const adminSupabase = createAdminClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse + validate request body
  let body: z.infer<typeof RequestSchema>;
  try {
    const raw = await request.json();
    body = RequestSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: err.errors },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { submission_id, answers, phase_label, phase_type, paired_diagnosis_id } = body;

  // Validate paired_diagnosis_id ownership + phase type
  if (paired_diagnosis_id) {
    const { data: pairedDiagnosis } = await supabase
      .from("diagnoses")
      .select("id, phase_type, user_id")
      .eq("id", paired_diagnosis_id)
      .eq("user_id", user.id)
      .eq("phase_type", "current")
      .single();

    if (!pairedDiagnosis) {
      return NextResponse.json(
        { error: "paired_diagnosis_id not found or not owned by user" },
        { status: 403 }
      );
    }

    // Prevent duplicate past diagnosis
    const { data: existingPaired } = await supabase
      .from("diagnoses")
      .select("id")
      .eq("paired_diagnosis_id", paired_diagnosis_id)
      .single();

    if (existingPaired) {
      return NextResponse.json(
        { error: "Past diagnosis already exists for this current diagnosis" },
        { status: 409 }
      );
    }
  }

  // Idempotency check
  const { data: existingDiagnosis } = await supabase
    .from("diagnoses")
    .select("id, diagnosis_results(id)")
    .eq("submission_id", submission_id)
    .single();

  if (existingDiagnosis) {
    const existingResults = existingDiagnosis.diagnosis_results;
    const resultId = Array.isArray(existingResults) && existingResults.length > 0
      ? existingResults[0].id
      : null;

    if (resultId) {
      // Both diagnosis and result exist — return cached
      return NextResponse.json({
        resultId,
        diagnosisId: existingDiagnosis.id,
      });
    }

    // Diagnosis exists but result is missing — re-run AI + save result
    const enrichedAnswers = enrichAnswers(answers);
    let aiResult;
    try {
      aiResult = await callAI({ phase_label, phase_type, answers: enrichedAnswers });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "AI_QUOTA_EXCEEDED") {
        return NextResponse.json({ error: "AI_QUOTA_EXCEEDED" }, { status: 429 });
      }
      throw err;
    }

    const { data: result, error: resultError } = await adminSupabase
      .from("diagnosis_results")
      .insert({
        diagnosis_id:      existingDiagnosis.id,
        architecture_name: aiResult.architecture_name,
        description:       aiResult.description,
        scores:            aiResult.scores,
        diagram_data:      aiResult.diagram_data,
      })
      .select("id")
      .single();

    if (resultError || !result) {
      console.error("Failed to save diagnosis result", resultError);
      return NextResponse.json({ error: "Failed to save result" }, { status: 500 });
    }

    return NextResponse.json({ resultId: result.id, diagnosisId: existingDiagnosis.id });
  }

  // New diagnosis — enrich answers, call AI, save to DB
  const enrichedAnswers = enrichAnswers(answers);

  let aiResult;
  try {
    aiResult = await callAI({ phase_label, phase_type, answers: enrichedAnswers });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "AI_QUOTA_EXCEEDED") {
      return NextResponse.json({ error: "AI_QUOTA_EXCEEDED" }, { status: 429 });
    }
    throw err;
  }

  const { data: diagnosis, error: diagnosisError } = await supabase
    .from("diagnoses")
    .insert({
      user_id:             user.id,
      submission_id,
      paired_diagnosis_id: paired_diagnosis_id ?? null,
      phase_label,
      phase_type,
      answers,
    })
    .select("id")
    .single();

  if (diagnosisError || !diagnosis) {
    return NextResponse.json({ error: "Failed to save diagnosis" }, { status: 500 });
  }

  const { data: result, error: resultError } = await adminSupabase
    .from("diagnosis_results")
    .insert({
      diagnosis_id:      diagnosis.id,
      architecture_name: aiResult.architecture_name,
      description:       aiResult.description,
      scores:            aiResult.scores,
      diagram_data:      aiResult.diagram_data,
    })
    .select("id")
    .single();

  if (resultError || !result) {
    console.error("Failed to save diagnosis result", resultError);
    return NextResponse.json({ error: "Failed to save result" }, { status: 500 });
  }

  return NextResponse.json({
    resultId:    result.id,
    diagnosisId: diagnosis.id,
  });
}
