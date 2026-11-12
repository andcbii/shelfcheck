"use client";
import { ManualMatchEditor } from "@/app/components/manual-match-editor";
type Props = { initialUrls: string[]; initialMappingId?: string; scanActive?: boolean; onClose: () => void; onChanged: (revision: number) => void };
export function ManualCoverageManager({onClose, ...props}: Props) {
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="modal manual-coverage-manager" role="dialog" aria-modal="true" aria-label="Matching Episodes"><header><h2>Matching Episodes</h2><button onClick={onClose} aria-label="Close Matching Episodes">Close</button></header><ManualMatchEditor {...props} episodeScope/></section></div>;
}
