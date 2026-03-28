import { getOptionalUser } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import LandingPage from "@/modules/auth/LandingPage";

interface Props {
  searchParams: Promise<{ error?: string }>;
}

export default async function Page({ searchParams }: Props) {
  const user = await getOptionalUser();
  const { error } = await searchParams;

  if (user) {
    redirect("/diagnosis");
  }

  return <LandingPage errorCode={error ?? null} />;
}
