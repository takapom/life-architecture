import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TimelineView from "@/modules/visualization/TimelineView";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TimelinePage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  // id is the current diagnosis id
  // Fetch current diagnosis + its result
  const { data: currentDiagnosis } = await supabase
    .from("diagnoses")
    .select(`
      *,
      diagnosis_results (*)
    `)
    .eq("id", id)
    .eq("phase_type", "current")
    .single();

  if (!currentDiagnosis) {
    notFound();
  }

  // Fetch past diagnosis via paired_diagnosis_id
  const { data: pastDiagnosis } = await supabase
    .from("diagnoses")
    .select(`
      *,
      diagnosis_results (*)
    `)
    .eq("paired_diagnosis_id", id)
    .single();

  if (!pastDiagnosis) {
    notFound();
  }

  return (
    <TimelineView
      current={currentDiagnosis}
      past={pastDiagnosis}
    />
  );
}
