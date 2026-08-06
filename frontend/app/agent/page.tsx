import type { Metadata } from "next";
import AgentPanel from "./agent-client";

export const metadata: Metadata = {
  title: "Agent",
};

export default function AgentPage() {
  return <AgentPanel />;
}
