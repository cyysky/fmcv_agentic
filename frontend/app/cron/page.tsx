import type { Metadata } from "next";
import CronPanel from "./cron-client";

export const metadata: Metadata = {
  title: "Cron",
};

export default function CronPage() {
  return <CronPanel />;
}
