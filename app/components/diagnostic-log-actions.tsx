"use client";

type Props = {
  endpoint: string;
  filename: string;
  confirmMessage: string;
  downloadError: string;
  deleteError: string;
  onError: (message: string) => void;
};

export function DiagnosticLogActions({ endpoint, filename, confirmMessage, downloadError, deleteError, onError }: Props) {
  async function download() {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      onError(body.error || downloadError);
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function remove() {
    if (!window.confirm(confirmMessage)) return;
    const response = await fetch(endpoint, { method: "DELETE" });
    if (!response.ok) onError(deleteError);
  }

  return <div><button type="button" onClick={download}>Download log</button><button type="button" onClick={remove}>Delete all logs</button></div>;
}
