export function scanProgressPercent(processed: number, total: number, running: boolean) {
  const percent = Math.round((processed / Math.max(total, 1)) * 100);
  return Math.max(0, Math.min(running ? 99 : 100, percent));
}
