import { execSync } from 'child_process';

export type VerticalAnnotation = {
  label: string;
  value: string; // ISO 8601 timestamp
};

// CloudWatch renders annotation labels inline on the graph; keep them short.
const MAX_LABEL_LENGTH = 80;
const DEPLOY_MARKER_COUNT = 20;

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
 * Synth must never fail because history is unavailable (local synth of a shallow
 * checkout, artifact-format edge cases), so any error degrades to no markers.
 */
export function deployMarkers(): VerticalAnnotation[] {
  try {
    const raw = execSync(`git log --first-parent -n ${DEPLOY_MARKER_COUNT} --format=%H|%cI|%s`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitLog(raw);
  } catch {
    return [];
  }
}
