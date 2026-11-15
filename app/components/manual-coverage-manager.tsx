"use client";
import { ManualMatchEditor } from "@/app/components/manual-match-editor";
import { Popup } from "@/app/components/popup";
type Props = { initialUrls: string[]; initialMappingId?: string; scanActive?: boolean; onClose: () => void; onChanged: (revision: number) => void };
export function ManualCoverageManager({onClose, ...props}: Props) {
  return <Popup title="Matching Episodes" className="manual-coverage-manager" onRequestClose={onClose}><ManualMatchEditor {...props} episodeScope/></Popup>;
}
