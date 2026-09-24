import Link from "next/link";
import { notFound } from "next/navigation";
import { currentProfile, isAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NAV = [
  ["/admin", "Live fleet"],
  ["/admin/fleet", "Fleet"],
  ["/admin/tickets", "Tickets"],
  ["/admin/announcements", "Announcements"],
  ["/admin/event-day", "Event day"],
  ["/admin/roster", "Roster"],
  ["/admin/routes", "Routes"],
  ["/admin/stops", "Stops"],
  ["/admin/audit", "Audit log"],
  ["/admin/health", "Health"],
] as const;

/**
 * Anyone who is not a TD admin — signed out included — gets the ordinary 404 page, not a
 * redirect to login: the admin console's existence is not advertised (BUILD_PLAN Stage 4).
 * The gateway enforces the same rule on /v1/admin/*; this is presentation, not the boundary.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!isAdmin(await currentProfile())) notFound();
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <nav
        aria-label="TD console"
        className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
      >
        <span className="font-semibold">TD Console</span>
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} className="text-muted hover:text-ink">
            {label}
          </Link>
        ))}
        <Link href="/" className="ml-auto text-muted hover:text-ink">
          Student view
        </Link>
      </nav>
      {children}
    </div>
  );
}
