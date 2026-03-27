import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export default async function GlobalNav() {
  const user = await getUser();

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        backgroundColor: "var(--color-bg)",
        borderBottom: "1px solid var(--color-border)",
        padding: "0 24px",
        height: "56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Link
        href={user ? "/diagnosis" : "/"}
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "0.875rem",
          color: "var(--color-text-muted)",
          textDecoration: "none",
          letterSpacing: "0.05em",
        }}
      >
        life-architecture
      </Link>
      {user && (
        <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
          <Link
            href="/history"
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "0.8rem",
              color: "var(--color-text-muted)",
              textDecoration: "none",
              letterSpacing: "0.05em",
            }}
          >
            /history
          </Link>
        </div>
      )}
    </nav>
  );
}
