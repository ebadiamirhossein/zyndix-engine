import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { listMeetings } from "@/lib/meetings/list";
import type { DatabaseWithWave1 } from "@/types/database-extensions";

export const metadata: Metadata = { title: "Pipeline — Zyndix Engine" };

// Reads live data per request; never prerendered.
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  canceled: "Canceled",
  rescheduled: "Rescheduled (replaced)",
  held: "Held",
  no_show: "No-show",
};

function when(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—";
}

/**
 * Meetings from Calendly (09 §U8). Plain semantic HTML; the design system is
 * applied at unit UD. The layout checks the session too, but a layout does not
 * re-render on navigation (Next 16 auth guide), so the page checks again
 * before reading any data.
 */
export default async function Page() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const meetings = await listMeetings(db as unknown as SupabaseClient<DatabaseWithWave1>);

  return (
    <section>
      <h1>Pipeline</h1>
      <h2>Meetings</h2>
      {meetings.length === 0 ? (
        <p>No meetings yet. Calendly bookings appear here once the webhook is live.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Start</th>
              <th scope="col">Status</th>
              <th scope="col">Lead</th>
              <th scope="col">Company</th>
              <th scope="col">Meeting</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => (
              <tr key={m.id}>
                <td>
                  <time dateTime={m.start_at ?? undefined}>{when(m.start_at)}</time>
                </td>
                <td>
                  {STATUS_LABEL[m.status] ?? m.status}
                  {m.outcome_recorded_by ? " (recorded by operator)" : ""}
                </td>
                <td>
                  {m.lead_id ? (m.lead_name ?? m.invitee_email) : `${m.invitee_name ?? m.invitee_email} — unmatched`}
                  {m.lead_state ? ` · ${m.lead_state}` : ""}
                </td>
                <td>{m.company_name ?? "—"}</td>
                <td>{m.event_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>Proposals, won and lost work, and payments arrive with U20.</p>
    </section>
  );
}
