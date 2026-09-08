import Logger from 'bunyan';

import {
  DEFAULT_FADES_SOURCE,
  FADES_SOURCE_KINDS,
  orderServiceScoringSource,
  parseFadesSource,
  redshiftScoringSource,
} from '../../lib/cron/fades-sources';
import { OrderServiceFadesSource } from '../../lib/cron/order-service-fades-source';
import { MockOrderStatusProvider } from '../../lib/providers/order';
import { V2FadesRowType } from '../../lib/repositories';
import { MockPostedOrderRepository } from '../../lib/repositories/posted-order-repository';

const log = Logger.createLogger({ name: 'test' });
log.level(Logger.FATAL);

describe('fades sources', () => {
  describe('parseFadesSource', () => {
    it('defaults to the order service', () => {
      expect(DEFAULT_FADES_SOURCE).toBe('order-service');
      expect(parseFadesSource(undefined)).toBe('order-service');
      expect(parseFadesSource('')).toBe('order-service');
    });

    it('accepts both kinds, case- and whitespace-insensitively', () => {
      expect(FADES_SOURCE_KINDS).toEqual(['order-service', 'redshift']);
      expect(parseFadesSource('redshift')).toBe('redshift');
      expect(parseFadesSource(' Redshift ')).toBe('redshift');
      expect(parseFadesSource('ORDER-SERVICE')).toBe('order-service');
    });

    it('falls back to the default on an unrecognised value instead of failing the cron', () => {
      const warnings: unknown[] = [];
      const warnLog = Logger.createLogger({ name: 'test' });
      warnLog.level(Logger.FATAL);
      warnLog.warn = ((...args: unknown[]) => {
        warnings.push(args);
        return true;
      }) as typeof warnLog.warn;

      expect(parseFadesSource('redshfit', warnLog)).toBe('order-service');
      expect(warnings).toHaveLength(1);
    });
  });

  describe('redshiftScoringSource', () => {
    it('rebuilds the view and then queries it, in that order', async () => {
      const calls: string[] = [];
      const rows: V2FadesRowType[] = [{ fillerAddress: '0x1', faded: 1, postTimestamp: 1, deadline: 2 }];
      const source = redshiftScoringSource({
        createFadesView: async () => {
          calls.push('createFadesView');
        },
        getFades: async () => {
          calls.push('getFades');
          return rows;
        },
      });

      expect(source.kind).toBe('redshift');
      expect(await source.fetchRows()).toEqual(rows);
      expect(calls).toEqual(['createFadesView', 'getFades']);
      expect(source.setDeadline).toBeUndefined();
      expect(source.lastResolution).toBeUndefined();
    });

    it('propagates a Redshift failure to the caller (the caller decides whether it is fatal)', async () => {
      const source = redshiftScoringSource({
        createFadesView: async () => {
          throw new Error('Redshift endpoint is not connectable');
        },
        getFades: async () => [],
      });
      await expect(source.fetchRows()).rejects.toThrow('not connectable');
    });
  });

  describe('orderServiceScoringSource', () => {
    it('adapts deadline and resolution summary onto the source', async () => {
      const inner = new OrderServiceFadesSource({
        postedOrders: new MockPostedOrderRepository(),
        orderStatus: new MockOrderStatusProvider(),
        fillerEndpoints: () => [],
        log,
        now: () => 1_800_000_000,
      });
      const source = orderServiceScoringSource(inner);

      expect(source.kind).toBe('order-service');
      expect(source.lastResolution?.()).toBeUndefined();
      source.setDeadline?.(123_456);
      expect(inner.deadlineMs).toBe(123_456);
      expect(await source.fetchRows()).toEqual([]);
      expect(source.lastResolution?.()).toMatchObject({ pendingPastDeadline: 0, resolved: 0 });
    });
  });
});
