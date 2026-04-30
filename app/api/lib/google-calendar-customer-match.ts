import type { SupabaseClient } from "@supabase/supabase-js";

export async function findCustomerProfileIdByContact(input: {
  supabase: SupabaseClient;
  businessId: string;
  email: string | null;
  phone: string | null;
}) {
  const { supabase, businessId, email, phone } = input;

  if (email && phone) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id")
      .eq("business_id", businessId)
      .ilike("email", email)
      .eq("phone", phone)
      .limit(2);

    if (error) throw error;
    if ((data ?? []).length === 1) return data![0].id as string;
  }

  if (email) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id")
      .eq("business_id", businessId)
      .ilike("email", email)
      .limit(2);

    if (error) throw error;
    if ((data ?? []).length === 1) return data![0].id as string;
  }

  if (phone) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id")
      .eq("business_id", businessId)
      .eq("phone", phone)
      .limit(2);

    if (error) throw error;
    if ((data ?? []).length === 1) return data![0].id as string;
  }

  return null;
}
