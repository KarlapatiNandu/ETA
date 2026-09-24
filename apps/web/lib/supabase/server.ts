import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicEnv } from "../env";

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a Server Component: the middleware refreshes the session instead
        }
      },
    },
  });
}

export type Profile = {
  id: string;
  roll_no: string;
  full_name: string;
  cohort: "junior" | "senior";
  role: "student" | "driver" | "td_admin" | "super_admin";
  phone_e164: string;
  travel_mode: "foot" | "bicycle" | "motorbike" | "car";
  default_buffer_s: number;
  max_tier: number;
};

/** The signed-in user's own profile (RLS returns only their row), or null. */
export async function currentProfile(): Promise<Profile | null> {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data } = await supabase
    .from("profiles")
    .select(
      "id, roll_no, full_name, cohort, role, phone_e164, travel_mode, default_buffer_s, max_tier",
    )
    .eq("id", auth.user.id)
    .single();
  return (data as Profile | null) ?? null;
}

export const isAdmin = (p: Profile | null) => p?.role === "td_admin" || p?.role === "super_admin";
