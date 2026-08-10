import { deployMarkers, MILESTONES, parseGitLog } from '../../bin/stacks/deploy-markers';
import {
  LambdaWidget,
  LatencyStoryRows,
  PhaseDecompositionWidgets,
  WastedWaitWidgets,
  withEventMarkers,
} from '../../bin/stacks/param-dashboard-stack';

describe('deployMarkers (executes real git)', () => {
  // Guards the actual subprocess invocation: a shell-quoting or argv regression
  // makes git exit non-zero and this silently degrades to [] in synth — the unit
  // tests on parseGitLog alone cannot catch that.
  it('returns at least one marker with a parseable timestamp when run inside a git repo', () => {
    const markers = deployMarkers();
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(Number.isNaN(Date.parse(m.value))).toBe(false);
      expect(m.label).toMatch(/^[0-9a-f]{7} /);
      expect(m.label.length).toBeLessThanOrEqual(50);
    }
    expect(markers.length).toBeLessThanOrEqual(10);
  });
});

describe('parseGitLog', () => {
  it('parses sha, timestamp, and subject into annotations', () => {
    const raw = [
      'aaaabbbbccccddddeeeeffff0000111122223333|2026-08-10T12:00:00-07:00|feat: something great (#480)',
      'ffffeeeeddddccccbbbbaaaa9999888877776666|2026-08-09T09:30:00Z|fix: a thing',
    ].join('\n');
    expect(parseGitLog(raw)).toEqual([
      { value: '2026-08-10T12:00:00-07:00', label: 'aaaabbb feat: something great (#480)' },
      { value: '2026-08-09T09:30:00Z', label: 'ffffeee fix: a thing' },
    ]);
  });

  it('keeps subjects containing pipes intact', () => {
    const [a] = parseGitLog('abcdef1234567890|2026-08-10T12:00:00Z|feat: a | b | c');
    expect(a.label).toEqual('abcdef1 feat: a | b | c');
  });

  it('truncates long labels and drops unparseable lines', () => {
    const long = `abcdef1234567890|2026-08-10T12:00:00Z|${'x'.repeat(200)}`;
    const [a] = parseGitLog(long);
    expect(a.label.length).toBeLessThanOrEqual(80);
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('garbage-without-pipes')).toEqual([]);
  });
});

describe('MILESTONES', () => {
  it('all have parseable ISO timestamps and labels', () => {
    for (const m of MILESTONES) {
      expect(Number.isNaN(Date.parse(m.value))).toBe(false);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('records the bulk dead quoter removal', () => {
    expect(MILESTONES.some((m) => m.label.includes('bulk dead quoter removal'))).toBe(true);
  });
});

describe('withEventMarkers', () => {
  const graph: LambdaWidget = {
    type: 'metric',
    width: 8,
    height: 7,
    properties: {
      view: 'timeSeries',
      stacked: false,
      region: 'us-east-2',
      title: 'a graph',
      annotations: { horizontal: [{ label: 'baseline', value: 575 }] },
    },
  };
  const tile: LambdaWidget = {
    type: 'metric',
    width: 6,
    height: 4,
    properties: { view: 'singleValue', stacked: false, region: 'us-east-2', title: 'a tile' },
  };
  const markers = [{ value: '2026-08-07T01:30:00Z', label: 'bulk dead quoter removal (RFQ config)' }];

  it('adds vertical markers to timeSeries widgets and preserves existing annotations', () => {
    const [g, t] = withEventMarkers([graph, tile], markers);
    expect(g.properties.annotations?.vertical).toEqual(markers);
    expect(g.properties.annotations?.horizontal).toEqual([{ label: 'baseline', value: 575 }]);
    expect(t.properties.annotations).toBeUndefined();
  });

  it('is a no-op for empty marker lists', () => {
    expect(withEventMarkers([graph], [])).toEqual([graph]);
  });

  it('keeps the marker-annotated widget payload within the dashboard size budget', () => {
    // PutDashboard rejects bodies >100KB; an unbounded marker regime measured
    // ~122KB. The markers go only on the attribution widgets, capped at 10 deploys
    // + milestones with 50-char labels. Worst-case payload for that subset must
    // leave ample room for the ~37KB of ops widgets that share the body.
    const worstCaseMarkers = Array.from({ length: 11 }, (_, i) => ({
      value: '2026-08-10T12:00:00-07:00',
      label: `${i.toString(16).padStart(7, '0')} ${'x'.repeat(42)}`,
    }));
    const annotated = withEventMarkers(
      [LatencyStoryRows('us-east-2'), PhaseDecompositionWidgets('us-east-2'), WastedWaitWidgets('us-east-2')].flat(),
      worstCaseMarkers
    );
    expect(JSON.stringify(annotated).length).toBeLessThan(55_000);
  });
});
