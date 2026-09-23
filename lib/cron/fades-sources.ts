import Logger from 'bunyan';

import { FADES_SOURCE_ENV } from '../constants';
import { V2FadesRowType } from '../repositories/fades-repository';
import { OrderServiceFadesSource, ResolutionSummary } from './order-service-fades-source';

/**
 * The two places the fade circuit breaker can get its per-order rows from. Exactly one is the
 * primary (its rows drive the block decisions that are written); the other runs as a shadow
 * (rows scored, nothing written, differences reported). Which is which is configuration
 * (FADES_SOURCE_ENV), so swapping back is a one-line config change, not a code revert.
 */
export type FadesSourceKind = 'order-service' | 'redshift';
export const FADES_SOURCE_KINDS: readonly FadesSourceKind[] = ['order-service', 'redshift'];
export const DEFAULT_FADES_SOURCE: FadesSourceKind = 'order-service';
// Where an UNRECOGNISED switch value lands. The switch exists so an operator can fall back to
// the path that ran in production for over a year; a fat-fingered revert (or a value rendered
// empty by templating) must therefore resolve toward Redshift, never toward the source being
// backed out of.
export const FALLBACK_FADES_SOURCE: FadesSourceKind = 'redshift';

/**
 * Reads the primary-source switch. Unset means the default. An unrecognised value is not the
 * default: it resolves to the long-running Redshift path (see FALLBACK_FADES_SOURCE), loudly.
 * Neither case fails the cron — a failed cron leaves stale blocks expiring with nothing
 * renewing them — but both are visible in the logs and on CIRCUIT_BREAKER_PRIMARY_IS_ORDER_SERVICE.
 */
export function parseFadesSource(value: string | undefined, log?: Logger): FadesSourceKind {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_FADES_SOURCE;
  }
  const kind = FADES_SOURCE_KINDS.find((k) => k === normalized);
  if (!kind) {
    log?.warn(
      { [FADES_SOURCE_ENV]: value, fallback: FALLBACK_FADES_SOURCE },
      'unrecognised fades source; falling back to the Redshift path'
    );
    return FALLBACK_FADES_SOURCE;
  }
  return kind;
}

/**
 * A fades source as the cron consumes it, in either role. `fetchRows` produces rows in the
 * shape of V2_FADE_RATE_SQL's result (see V2FadesRowType), including whatever preparation the
 * source needs (Redshift: rebuilding its view; order service: resolving pending outcomes).
 */
export interface FadesScoringSource {
  readonly kind: FadesSourceKind;
  fetchRows(): Promise<V2FadesRowType[]>;
  // Wallclock (ms) after which best-effort work stops, honoured when running as the shadow.
  setDeadline?(deadlineMs: number): void;
  // Outcome-resolution summary of the last fetchRows (order service only).
  lastResolution?(): ResolutionSummary | undefined;
}

export type RedshiftFadesRepository = {
  createFadesView(): Promise<void>;
  getFades(): Promise<V2FadesRowType[]>;
};

/** The Redshift path exactly as the cron has always run it: rebuild the view, then query it. */
export function redshiftScoringSource(repository: RedshiftFadesRepository): FadesScoringSource {
  return {
    kind: 'redshift',
    fetchRows: async () => {
      await repository.createFadesView();
      return repository.getFades();
    },
  };
}

/** The GPA-owned path: resolve pending outcomes against the order service, then build rows. */
export function orderServiceScoringSource(source: OrderServiceFadesSource): FadesScoringSource {
  return {
    kind: 'order-service',
    fetchRows: () => source.getFades(),
    setDeadline: (deadlineMs) => {
      source.deadlineMs = deadlineMs;
    },
    lastResolution: () => source.lastResolution,
  };
}
