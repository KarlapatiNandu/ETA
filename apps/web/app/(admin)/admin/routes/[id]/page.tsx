"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use } from "react";

// MapLibre needs a browser: the editor never renders on the server
const RouteEditor = dynamic(
  () => import("@/components/admin/route-editor").then((m) => m.RouteEditor),
  {
    ssr: false,
    loading: () => <p className="text-muted">Loading the map…</p>,
  },
);

export default function RouteEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="space-y-3">
      <Link href="/admin/routes" className="text-sm text-muted underline">
        ← all routes
      </Link>
      <RouteEditor routeId={id} />
    </div>
  );
}
