"use client";
import { useRouter } from "next/navigation";
import type { MultipleProviderIdEntry } from "@/lib/multiple-provider-ids-report";
import { MultipleProviderIdReport } from "@/app/reports/components/multiple-provider-id-report";

export function MultipleProviderIdReportView({ entries, initialScanning }: { entries: MultipleProviderIdEntry[]; initialScanning: boolean }) {
  const router = useRouter();
  return <MultipleProviderIdReport entries={entries} initialScanning={initialScanning} onChanged={() => router.refresh()} />;
}
