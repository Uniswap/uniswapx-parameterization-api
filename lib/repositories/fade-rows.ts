// Most-recent orders per filler ADDRESS evaluated for the fade rate. Combined with the 24h
// completion window the lookback is adaptive: a high-volume filler is judged on its latest N
// orders (fast reaction), a low-volume filler on up to 24h of orders (catches chronic fading).
export const ORDERS_PER_FILLER_LIMIT = 100;

/**
 * One completed order as the fade breaker scores it. The shape (and name) is inherited from the
 * retired Redshift query so the scoring code did not change when the source did; it is now
 * produced by lib/cron/order-service-fades-source.ts from PostedOrders + the order service.
 */
export type V2FadesRowType = {
  // Exclusive filler address the order was posted with (checksummed).
  fillerAddress: string;
  // 1 = fade (expired, or filled after decay start), 0 = clean fill.
  faded: number;
  // Unix seconds the post was confirmed.
  postTimestamp: number;
  // Unix seconds the order's deadline passed — "completion" for the breaker.
  deadline: number;
};
