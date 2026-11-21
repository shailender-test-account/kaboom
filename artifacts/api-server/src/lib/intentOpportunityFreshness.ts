export const INBOUND_HOT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export function isFreshInboundHot(value: unknown, now = new Date()): boolean {
  if (!value) return false;
  const timestamp = new Date(value as string).getTime();
  return Number.isFinite(timestamp) && timestamp <= now.getTime() &&
    timestamp >= now.getTime() - INBOUND_HOT_WINDOW_MS;
}