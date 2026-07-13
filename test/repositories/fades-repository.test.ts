import { ORDERS_PER_FILLER_LIMIT, V2_CREATE_VIEW_SQL, V2_FADE_RATE_SQL } from '../../lib/repositories';

describe('V2FadesRepository SQL', () => {
  describe('V2_CREATE_VIEW_SQL', () => {
    it('bounds the CTE row set to the 1-hour lookback window before any LIMIT truncation', () => {
      // The inner CTE over postedorders grows with the all-time filler count
      // (up to ORDERS_PER_FILLER_LIMIT rows per filler). If the time-window
      // filter were applied only after a LIMIT, the LIMIT would truncate an
      // unordered row set nondeterministically and silently drop recent orders
      // (missed fades / phantom blocks). The window filter must come first.
      const windowFilterIndex = V2_CREATE_VIEW_SQL.indexOf("INTERVAL '1 HOUR'");
      const firstLimitIndex = V2_CREATE_VIEW_SQL.indexOf('LIMIT 5000');
      expect(windowFilterIndex).toBeGreaterThan(-1);
      expect(firstLimitIndex).toBeGreaterThan(-1);
      expect(windowFilterIndex).toBeLessThan(firstLimitIndex);
    });

    it('applies the 1-hour window inside the CTE, before the per-filler row_num filter', () => {
      const cteEnd = V2_CREATE_VIEW_SQL.indexOf(`row_num <= ${ORDERS_PER_FILLER_LIMIT}`);
      expect(cteEnd).toBeGreaterThan(-1);
      const beforeRowNumFilter = V2_CREATE_VIEW_SQL.slice(0, cteEnd);
      expect(beforeRowNumFilter).toContain("INTERVAL '1 HOUR'");
    });

    it('orders the CTE deterministically before its LIMIT', () => {
      const firstLimitIndex = V2_CREATE_VIEW_SQL.indexOf('LIMIT 5000');
      const beforeFirstLimit = V2_CREATE_VIEW_SQL.slice(0, firstLimitIndex);
      expect(beforeFirstLimit).toMatch(/ORDER BY deadline DESC, quoteid/);
    });

    it('caps evaluated orders per filler at ORDERS_PER_FILLER_LIMIT', () => {
      expect(V2_CREATE_VIEW_SQL).toContain(`row_num <= ${ORDERS_PER_FILLER_LIMIT}`);
    });
  });

  describe('V2_FADE_RATE_SQL', () => {
    it('counts a Dutch_V3 fill strictly after decayStartBlock as a fade', () => {
      expect(V2_FADE_RATE_SQL).toContain('fillTimeBlocks > 0');
      expect(V2_FADE_RATE_SQL).not.toContain('fillTimeBlocks >= 0');
    });
  });
});
