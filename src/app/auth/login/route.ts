import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const rawNext = url.searchParams.get("next") ?? "/diagnosis";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//")
    ? rawNext
    : "/diagnosis";

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    if (error || !data.url) {
      throw error ?? new Error("GitHub OAuth URL was not returned");
    }

    return NextResponse.redirect(data.url);
  } catch (error) {
    console.error("GitHub OAuth start failed", error);
    return NextResponse.redirect(`${origin}/?error=auth-start`);
  }
}
