import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ResultView from "@/modules/result/ResultView";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ResultPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: result } = await supabase
    .from("diagnosis_results")
    .select(
      `
      *,
      diagnoses (
        id,
        user_id,
        phase_label,
        phase_type,
        paired_diagnosis_id,
        created_at
      )
    `
    )
    .eq("id", id)
    .single();

  if (!result) {
    notFound();
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <ResultView
      result={result}
      diagnosis={result.diagnoses}
      isOwner={user?.id === result.diagnoses?.user_id}
      isLoggedIn={!!user}
    />
  );
}
