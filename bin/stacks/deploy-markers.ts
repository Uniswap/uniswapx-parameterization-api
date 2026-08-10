import { execFileSync } from 'child_process';

export type VerticalAnnotation = {
  label: string;
  value: string; // ISO 8601 timestamp
};

// Markers are copied into every widget they annotate and the dashboard body has a
// hard 100KB PutDashboard limit, so both the marker count and label length are
// deliberately small. See MARKER_WIDGET_BUDGET in param-dashboard-stack.ts.
const MAX_LABEL_LENGTH = 50;
const DEPLOY_MARKER_COUNT = 10;

/**
 * Hand-maintained markers for changes that move the latency graphs but leave no
 * trace in this repo's git history (config-repo changes, partner-side events).
 * Automatic coverage exists for the two common cases — this-repo merges (git-derived
 * markers below) and RFQ config edits (the RFQ_CONFIG_CHANGED metric strip) — so
 * this list is only for rare milestones worth labeling forever.
 */
export const MILESTONES: VerticalAnnotation[] = [
  { value: '2026-08-07T01:30:00Z', label: 'bulk dead quoter removal (RFQ config)' },
];

/** Parses `git log --format=%H|%cI|%s` output into vertical annotations. */
export function parseGitLog(raw: string): VerticalAnnotation[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, committedAt, ...subjectParts] = line.split('|');
      return {
        value: committedAt,
        label: `${sha.slice(0, 7)} ${subjectParts.join('|')}`.slice(0, MAX_LABEL_LENGTH),
      };
    })
    .filter((a) => !Number.isNaN(Date.parse(a.value)));
}

/**
 * Vertical markers for the last merges to main, read from git at synth time. The
 * pipeline's synth step has a full clone (codeBuildCloneOutput in bin/app.ts).
 * Marker time is the merge-commit time; the new code serves ~15-30 min later when
 * the pipeline finishes — invisible at the dashboard's 3-month default zoom, and
 * the invocations-by-version widget gives the exact traffic-shift moment.
 *
 * execFileSync (not execSync): the format string contains `|`, which a shell would
 * parse as a pipeline; execFileSync passes argv directly with no shell involved.
 *
 * Synth must never fail because history is unavailable (shallow checkout, artifact
 * edge cases), so any error degrades to no markers — but LOUDLY, so a regression
 * here is visible in the synth log instead of silently shipping a bare dashboard.
 */
export function deployMarkers(): VerticalAnnotation[] {
  try {
    const raw = execFileSync('git', ['log', '--first-parent', '-n', `${DEPLOY_MARKER_COUNT}`, '--format=%H|%cI|%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseGitLog(raw);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`deploy-markers: git history unavailable, dashboard will have no deploy markers: ${e}`);
    return [];
  }
}
