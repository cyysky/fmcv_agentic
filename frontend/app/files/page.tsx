import type { Metadata } from "next";
import FilesPanel from "./files-client";

export const metadata: Metadata = {
  title: "Files",
};

export default function FilesPage() {
  return <FilesPanel />;
}
