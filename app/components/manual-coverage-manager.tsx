"use client";
import { ManualMatchEditor } from "@/app/components/manual-match-editor";
type Props = { initialUrls: string[]; initialMappingId?: string; scanActive?: boolean; onClose: () => void; onChanged: (revision: number) => void };
export function ManualCoverageManager({onClose, ...props}: Props) {
  return <div className="modal-backdrop"><section className="modal manual-coverage-manager" role="dialog" aria-modal="true" aria-label="Manual Coverage"><header><h2>Manual Coverage</h2><button onClick={onClose} aria-label="Close manual coverage">Close</button></header><ManualMatchEditor {...props}/></section></div>;
}
