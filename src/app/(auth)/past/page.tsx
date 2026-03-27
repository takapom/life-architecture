import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PastPhaseSelector from "@/modules/history/PastPhaseSelector";

interface Props {
  searchParams: Promise<{ diagnosisId?: string }>;
}

export default async function PastPage({ searchParams }: Props) {
  const { diagnosisId } = await searchParams;

  if (!diagnosisId) {
    redirect("/diagnosis");
  }

  const supabase = await createClient();

  // Check this diagnosis exists and belongs to the user
  const { data: { user } } = await supabase.auth.getUser();
  const { data: diagnosis } = await supabase
    .from("diagnoses")
    .select("id, paired_diagnosis_id")
    .eq("id", diagnosisId)
    .eq("user_id", user!.id)
    .single();

  if (!diagnosis) {
    redirect("/diagnosis");
  }

  // If past diagnosis already exists, redirect to timeline
  if (diagnosis.paired_diagnosis_id) {
    redirect(`/timeline/${diagnosisId}`);
  }

  return <PastPhaseSelector currentDiagnosisId={diagnosisId} />;
}
