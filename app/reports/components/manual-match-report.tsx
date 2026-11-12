"use client";
import { useRouter } from "next/navigation";
import { ManualMatchEditor } from "@/app/components/manual-match-editor";
const initialUrls: string[] = [];
export function ManualMatchReport() {
  const router = useRouter();
  return <ManualMatchEditor initialUrls={initialUrls} report onChanged={() => router.refresh()} />;
}
