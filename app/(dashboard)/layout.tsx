import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BUSINESS_ID } from "@/app/api/config";
import { Sidebar } from "../../components/dashboard/sidebar";
import { Topbar } from "../../components/dashboard/topbar";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const headerList = await headers();
  const pathname = headerList.get("x-pathname") ?? "/dashboard";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const admin = createSupabaseServiceRoleClient();
  const { data: membership, error } = await admin
    .from("business_users")
    .select("id")
    .eq("user_id", user.id)
    .eq("business_id", BUSINESS_ID)
    .eq("active", true)
    .maybeSingle();

  if (error || !membership) {
    redirect("/unauthorized");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <div className="flex min-h-screen">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />

          <main className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.11),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#f1f5f9_100%)]">
            <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-5 lg:px-6 lg:py-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
