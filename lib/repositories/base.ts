export type TimestampRepoRow = {
  hash: string;
  // Timestamp of the last cron run that examined this filler; boundary for "new since last run".
  lastExaminedTimestamp: number;
  // Block expiry; 0 (UNBLOCKED_BLOCK_UNTIL_TIMESTAMP) when the filler is not blocked.
  blockUntilTimestamp: number;
  // Clean-slate floor for the fade-rate window: only orders completed after this are scored.
  // Set to the block end whenever a block is applied/extended; 0 if the filler was never blocked.
  fadeWindowStart: number;
  consecutiveBlocks: number;
  // Streak of consecutive clean runs (cron runs with >=1 new completion and 0 new fades)
  // while unblocked and escalated. consecutiveBlocks decays one level per
  // CLEAN_RUNS_PER_DECAY of these; any new fade resets the streak, idle runs freeze it.
  consecutiveCleanRuns: number;
};

// Rows round-trip as native numbers now (number-typed attributes read via a wrapNumbers:false
// client), so the raw shape matches TimestampRepoRow — no string parsing.
export type DynamoTimestampRepoRow = TimestampRepoRow;

// consecutiveCleanRuns stays required here: updateTimestampsBatch does a full-item put, so an
// optional field a caller forgets to set would silently wipe the stored streak (reads default
// missing attributes to 0).
export type ToUpdateTimestampRow = Omit<TimestampRepoRow, 'blockUntilTimestamp' | 'fadeWindowStart'> & {
  blockUntilTimestamp?: number;
  fadeWindowStart?: number;
};

/*
  fillerHash -> { lastExaminedTimestamp, blockUntilTimestamp, fadeWindowStart, consecutiveBlocks }
*/
export type FillerTimestampMap = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export interface BaseTimestampRepository {
  updateTimestampsBatch(toUpdate: ToUpdateTimestampRow[]): Promise<void>;
  getFillerTimestamps(hash: string): Promise<TimestampRepoRow>;
  getFillerTimestampsMap(hashes: string[]): Promise<Map<string, Omit<TimestampRepoRow, 'hash'>>>;
  getTimestampsBatch(hashes: string[]): Promise<TimestampRepoRow[]>;
}
