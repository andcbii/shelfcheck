export function isActiveRateLimitPause(scanRunning: boolean, rateLimitPaused: boolean | undefined) {
  return scanRunning && rateLimitPaused === true;
}
