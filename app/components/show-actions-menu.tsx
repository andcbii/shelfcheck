"use client";

type Props = {
  onIgnoreShow: () => void;
  onForceCheck: () => void;
  onClearCache: () => void;
  onIgnoreSeasons: () => void;
};

export function ShowActionsMenu({ onIgnoreShow, onForceCheck, onClearCache, onIgnoreSeasons }: Props) {
  return <div className="show-action-menu" role="menu">
    <button type="button" role="menuitem" onClick={onIgnoreShow} title="Remove this show from saved scan results and skip it during future scans">⊘ <span>Ignore this show</span></button>
    <button type="button" role="menuitem" onClick={onForceCheck}>⟳ <span>Force check now</span></button>
    <button type="button" role="menuitem" onClick={onClearCache}>↻ <span>Clear show&apos;s cache</span></button>
    <button type="button" role="menuitem" onClick={onIgnoreSeasons}>▤ <span>Ignore seasons</span></button>
  </div>;
}
