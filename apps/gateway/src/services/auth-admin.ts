import { createClient } from "@supabase/supabase-js";

/**
 * The slice of Supabase Auth's admin API the claim and recovery flows use. Service-role
 * only; never reachable from a browser.
 */
export interface AuthAdmin {
  createUser(input: { email: string; password: string; rollNo: string }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  updatePassword(id: string, password: string): Promise<void>;
}

export function createSupabaseAuthAdmin(url: string, serviceRoleKey: string): AuthAdmin {
  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }).auth.admin;
  return {
    async createUser({ email, password, rollNo }) {
      const { data, error } = await admin.createUser({
        email,
        password,
        email_confirm: true, // the synthetic address is never mailed; identity was proven by OTP
        app_metadata: { roll_no: rollNo },
      });
      if (error || !data.user) throw new Error(`auth.createUser failed: ${error?.message}`);
      return { id: data.user.id };
    },
    async deleteUser(id) {
      const { error } = await admin.deleteUser(id);
      if (error) throw new Error(`auth.deleteUser failed: ${error.message}`);
    },
    async updatePassword(id, password) {
      const { error } = await admin.updateUserById(id, { password });
      if (error) throw new Error(`auth.updateUserById failed: ${error.message}`);
    },
  };
}
