import type { Metadata } from "next";
import SkillsPanel from "./skills-client";

export const metadata: Metadata = {
  title: "Skills",
};

export default function SkillsPage() {
  return <SkillsPanel />;
}
