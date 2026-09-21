import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview — Zyndix Engine" };

export default function Page() {
  return (
    <section>
      <h1>Overview</h1>
      <p>Nothing here yet.</p>
      <p>This area will hold: Due actions, pipeline, exceptions, campaign health, costs and outcomes.</p>
      <p>U9 wires the orchestrator and pause controls; U21 adds costs and outcomes.</p>
    </section>
  );
}
