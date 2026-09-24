import { AlertSettingsPanel } from "@/components/notifications/alert-settings";
import { HomePinEditor } from "@/components/settings/home-pin";
import { currentProfile } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const profile = (await currentProfile())!;
  return (
    <>
      <SettingsForm profile={profile} />
      <HomePinEditor />
      <AlertSettingsPanel />
    </>
  );
}
