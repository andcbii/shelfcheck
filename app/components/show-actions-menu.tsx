"use client";

type Props = {
  onIgnoreShow: () => void;
  onForceCheck: () => void;
  onClearCache: () => void;
  onIgnoreSeasons: () => void;
};

export function ShowActionsMenu({ onIgnoreShow, onForceCheck, onClearCache, onIgnoreSeasons }: Props) {
  function openIgnoreDialog(button: HTMLButtonElement, onOpen: () => void) {
    button.closest("[data-show-menu-id]")?.querySelector<HTMLButtonElement>(".show-name-button")?.focus();
    onOpen();
  }

  return <div className="show-action-menu" role="menu">
    <button type="button" role="menuitem" onClick={(event) => openIgnoreDialog(event.currentTarget, onIgnoreShow)} aria-haspopup="dialog" title="Choose how long to remove this show from saved results and skip it during scans">⊘ <span>Ignore this show</span></button>
    <button type="button" role="menuitem" onClick={onForceCheck}>⟳ <span>Force check now</span></button>
    <button type="button" role="menuitem" onClick={onClearCache}>↻ <span>Clear show&apos;s cache</span></button>
    <button type="button" role="menuitem" onClick={(event) => openIgnoreDialog(event.currentTarget, onIgnoreSeasons)} aria-haspopup="dialog">▤ <span>Ignore seasons</span></button>
  </div>;
}
