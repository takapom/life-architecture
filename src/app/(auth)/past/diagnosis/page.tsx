import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DiagnosisFlow from "@/modules/diagnosis/DiagnosisFlow";

interface Props {
  searchParams: Promise<{ diagnosisId?: string; phaseLabel?: string }>;
}

export default async function PastDiagnosisPage({ searchParams }: Props) {
  const { diagnosisId, phaseLabel } = await searchParams;

  if (!diagnosisId || !phaseLabel) {
    redirect("/diagnosis");
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Validate ownership
  const { data: diagnosis } = await supabase
    .from("diagnoses")
    .select("id")
    .eq("id", diagnosisId)
    .eq("user_id", user!.id)
    .eq("phase_type", "current")
    .single();

  if (!diagnosis) {
    redirect("/diagnosis");
  }

  return (
    <DiagnosisFlow
      mode="past"
      phaseLabel={decodeURIComponent(phaseLabel)}
      phaseType="past"
      pairedDiagnosisId={diagnosisId}
    />
  );
}
