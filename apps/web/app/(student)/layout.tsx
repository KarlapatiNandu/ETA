import Link from "next/link";
import { redirect } from "next/navigation";
import { LiveProvider } from "@/components/live/live-provider";
import { ArrivalBanner, Bell } from "@/components/notifications/inbox-bar";
import { currentProfile, isAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const profile = await currentProfile();
  if (!profile) redirect("/login");
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <LiveProvider>
        <nav className="mb-6 flex items-center justify-between text-sm">
          <Link href="/" className="font-semibold tracking-wide">
            Bus Mitra
          </Link>
          <div className="flex gap-4 text-muted">
            <Link href="/search">Search</Link>
            <Bell />
            {isAdmin(profile) && <Link href="/admin">Admin</Link>}
            <Link href="/settings">Settings</Link>
          </div>
        </nav>
        <ArrivalBanner />
        {children}
      </LiveProvider>
    </div>
  );
}
