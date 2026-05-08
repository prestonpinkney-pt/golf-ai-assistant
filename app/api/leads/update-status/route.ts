import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { gateBusinessUser } from "../../lib/require-auth";
import { VALID_LEAD_STATUSES } from "../_shared";

export async function POST(req: Request) {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "id and status are required" },
        { status: 400 }
      );
    }

    if (!VALID_LEAD_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    const { error } = await supabaseAdmin
      .from("leads")
      .update({
        status,
        last_contacted_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to update status" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
    });
  } catch (error: any) {
    console.error("Update status error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to update status" },
      { status: 500 }
    );
  }
}