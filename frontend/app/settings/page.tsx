import type { Metadata } from "next";
import SettingsPanel from "./settings-client";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <SettingsPanel />;
}
