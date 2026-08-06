import { PERMISSIONED_TOKENS } from '@uniswap/uniswapx-sdk';

import { V2_CREATE_VIEW_SQL, V2_FADE_RATE_SQL } from '../../lib/repositories/fades-repository';

// The view's projection list, parsed as alias -> source table, from its "<table>.<column> as <alias>" items.
const viewProjections = (): Record<string, string> => {
  const projections: Record<string, string> = {};
  for (const match of V2_CREATE_VIEW_SQL.matchAll(/(\w+)\.(\w+)\s+as\s+(\w+)/gi)) {
    const [, table, , alias] = match;
    projections[alias.toLowerCase()] = table.toLowerCase();
  }
  return projections;
};

// Columns the fade query filters with a bare `LOWER(<column>) NOT IN (...)` -- i.e. with no NULL guard.
const unguardedNotInColumns = (): string[] =>
  [...V2_FADE_RATE_SQL.matchAll(/LOWER\((\w+)\)\s+NOT IN \(/gi)].map((match) => match[1].toLowerCase());

describe('V2FadesRepository SQL', () => {
  describe('permissioned-token filter vs never-filled orders', () => {
    // The regression this pins: a filler that wins an order and never fills it must count toward
    // its fade rate. Never-filled orders have no archivedorders row, so every archived-side column
    // is NULL for them. `NULL NOT IN (...)` evaluates to NULL rather than TRUE, and a WHERE clause
    // keeps only TRUE, so sourcing the filtered token columns from the LEFT-JOINed side deleted the
    // entire never-filled cohort from both the numerator and the denominator.
    it('sources every column the unguarded NOT IN filters on from the non-nullable postedorders side', () => {
      const projections = viewProjections();
      const filteredColumns = unguardedNotInColumns();

      // Guards the guard: if the predicate ever stops being parsed out, the loop below is vacuous.
      expect(filteredColumns).toEqual(['tokenin', 'tokenout']);

      for (const column of filteredColumns) {
        expect(projections).toHaveProperty(column);
        expect(projections[column]).toEqual('latestordersv2');
      }
    });

    it('does not project the token columns from archivedorders under any spelling', () => {
      expect(V2_CREATE_VIEW_SQL).not.toMatch(/archivedorders\.token(in|out)/i);
    });

    it('still projects fillTimestamp from archivedorders, since its NULL is the never-filled signal', () => {
      // The asymmetry is deliberate: fillTimestamp must stay nullable (it is what identifies a
      // never-filled order) and is read with an explicit `IS NULL`, which is NULL-safe.
      expect(viewProjections()['filltimestamp']).toEqual('archivedorders');
      expect(V2_FADE_RATE_SQL).toContain('WHEN fillTimestamp IS NULL THEN 1');
    });
  });

  describe('permissioned-token exclusion', () => {
    // Deleting the exclusion would also stop never-filled orders being dropped, so pin that the
    // fix kept it. An empty NOT IN () list would additionally be a Redshift syntax error.
    it('excludes every permissioned token, lowercased to match the LOWER() comparison', () => {
      expect(PERMISSIONED_TOKENS.length).toBeGreaterThan(0);

      for (const token of PERMISSIONED_TOKENS) {
        expect(V2_FADE_RATE_SQL).toContain(`'${token.address.toLowerCase()}'`);
      }
      expect(V2_FADE_RATE_SQL).not.toMatch(/NOT IN \(\s*\)/);
    });

    it('applies the exclusion to both sides of the trade', () => {
      expect(unguardedNotInColumns()).toHaveLength(2);
    });
  });

  describe('fade classification', () => {
    it('treats a never-filled order of any type as a fade', () => {
      expect(V2_FADE_RATE_SQL).toContain('WHEN fillTimestamp IS NULL THEN 1');
    });

    it('counts a Dutch_V3 fill only strictly after decayStartBlock as a fade', () => {
      expect(V2_FADE_RATE_SQL).toContain('fillTimeBlocks > 0');
      expect(V2_FADE_RATE_SQL).not.toContain('fillTimeBlocks >= 0');
    });
  });
});
