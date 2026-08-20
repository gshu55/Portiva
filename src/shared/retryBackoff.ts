export function exponentialBackoffDelay(
  consecutiveFailures: number,
  baseDelayMs: number,
  maximumDelayMs: number,
) {
  const normalizedFailures = Math.max(0, Math.min(30, Math.floor(consecutiveFailures)));
  const normalizedBaseDelay = Math.max(1, Math.floor(baseDelayMs));
  const normalizedMaximumDelay = Math.max(normalizedBaseDelay, Math.floor(maximumDelayMs));

  return Math.min(
    normalizedMaximumDelay,
    normalizedBaseDelay * (2 ** normalizedFailures),
  );
}
