import { getReportData } from "@/app/reports/report-data";
import { CoverageIssuesWorkspace } from "@/app/reports/components/coverage-issues-workspace";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";
export default function CoverageIssuesPage(){
  const { issues, counts } = getReportData();
  return <main><ReportTopbar/><CoverageIssuesWorkspace initialIssues={issues} {...counts}/></main>;
}
