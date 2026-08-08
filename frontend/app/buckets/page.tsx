import type { Metadata } from "next";
import BucketsPanel from "./buckets-client";

export const metadata: Metadata = {
  title: "Buckets",
};

export default function BucketsPage() {
  return <BucketsPanel />;
}
