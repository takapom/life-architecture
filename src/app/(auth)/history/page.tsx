import { createClient } from "@/lib/supabase/server";
import HistoryList from "@/modules/history/HistoryList";

export default async function HistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: raw } = await supabase
    .from("diagnoses")
    .select(
      `
      id,
      phase_label,
      phase_type,
      paired_diagnosis_id,
      created_at,
      diagnosis_results (
        id,
        architecture_name
      )
    `
    )
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false });

  // Supabase returns diagnosis_results as an array; normalize to single item or null
  const diagnoses = (raw ?? []).map((d) => ({
    ...d,
    diagnosis_results: Array.isArray(d.diagnosis_results)
      ? (d.diagnosis_results[0] ?? null)
      : d.diagnosis_results,
  }));

  return <HistoryList diagnoses={diagnoses} />;
}
