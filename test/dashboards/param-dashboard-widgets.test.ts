import {
  BASELINE_E2E_P50_MS,
  BASELINE_E2E_P90_MS,
  BASELINE_E2E_P99_MS,
  BASELINE_HARD_E2E_P50_MS,
  BASELINE_HARD_E2E_P90_MS,
  BASELINE_HARD_E2E_P99_MS,
  E2EByChainWidgets,
  FanoutByChainWidgets,
  HardPercentileGraphs,
  LambdaWidget,
  LatencyStoryRows,
  PhaseDecompositionWidgets,
  SoftPercentileGraphs,
  WastedWaitWidgets,
} from '../../bin/stacks/param-dashboard-stack';

const REGION = 'us-east-2';

const allWidgets = (): LambdaWidget[] => [
  ...LatencyStoryRows(REGION),
  ...PhaseDecompositionWidgets(REGION),
  ...WastedWaitWidgets(REGION),
  ...E2EByChainWidgets(REGION),
  ...FanoutByChainWidgets(REGION),
];

describe('latency dashboard widgets', () => {
  it('produce serializable widgets within grid bounds', () => {
    for (const w of allWidgets()) {
      expect(() => JSON.stringify(w)).not.toThrow();
      expect(w.width).toBeGreaterThan(0);
      expect(w.width).toBeLessThanOrEqual(24);
      expect(w.height).toBeGreaterThan(0);
      expect(w.properties.region).toEqual(REGION);
      expect(w.properties.title.length).toBeGreaterThan(0);
    }
  });

  it('story rows form even rows: consecutive widths sum to 24 with uniform heights per row', () => {
    const widgets = LatencyStoryRows(REGION);
    let rowWidth = 0;
    let rowHeights = new Set<number>();
    for (const w of widgets) {
      rowWidth += w.width;
      rowHeights.add(w.height);
      expect(rowWidth).toBeLessThanOrEqual(24);
      if (rowWidth === 24) {
        expect(rowHeights.size).toEqual(1);
        rowWidth = 0;
        rowHeights = new Set<number>();
      }
    }
    expect(rowWidth).toEqual(0);
  });

  it('every story widget title says Soft or Hard', () => {
    for (const w of LatencyStoryRows(REGION)) {
      expect(w.properties.title).toMatch(/Soft|Hard/);
    }
  });

  it.each([
    ['Soft', SoftPercentileGraphs, [BASELINE_E2E_P50_MS, BASELINE_E2E_P90_MS, BASELINE_E2E_P99_MS]],
    ['Hard', HardPercentileGraphs, [BASELINE_HARD_E2E_P50_MS, BASELINE_HARD_E2E_P90_MS, BASELINE_HARD_E2E_P99_MS]],
  ] as const)('each %s percentile graph carries its own frozen baseline annotation', (name, row, baselines) => {
    const graphs = row(REGION);
    expect(graphs).toHaveLength(3);
    graphs.forEach((g, i) => {
      expect(g.properties.view).toEqual('timeSeries');
      expect(g.properties.title).toContain(name);
      const annotations = g.properties.annotations?.horizontal ?? [];
      expect(annotations.some((a) => a.value === baselines[i] && a.label?.includes('baseline'))).toBe(true);
    });
  });

  it('hard graphs use an hourly period (hard volume is too low for 5-minute percentiles)', () => {
    for (const g of HardPercentileGraphs(REGION)) {
      expect(g.properties.period).toBeGreaterThanOrEqual(3600);
    }
  });

  it('by-chain widgets discover chains via SEARCH instead of a static chain list', () => {
    for (const w of [...E2EByChainWidgets(REGION), ...FanoutByChainWidgets(REGION)]) {
      const rows = w.properties.metrics ?? [];
      expect(rows).toHaveLength(1);
      const expr = rows[0][0] as Exclude<LambdaWidget['properties']['metrics'], undefined>[0][0] & object as {
        expression?: string;
      };
      expect(expr.expression).toContain("SEARCH('{Uniswap,Service,ChainId}");
      expect(expr.expression).toContain('MetricName=');
    }
  });

  it('every math expression has its input ids present in the same widget', () => {
    for (const w of allWidgets()) {
      const rows = w.properties.metrics ?? [];
      const ids = new Set<string>();
      const exprs: string[] = [];
      for (const row of rows) {
        for (const part of row) {
          if (typeof part === 'object') {
            if (part.id) ids.add(part.id);
            if (part.expression) exprs.push(part.expression);
          }
        }
      }
      for (const e of exprs.filter((x) => !x.startsWith('SEARCH'))) {
        // every bare identifier in the expression must be a metric id in this widget
        const referenced = (e.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []).filter((t) => t !== 'RUNNING_SUM');
        for (const ref of referenced) {
          expect(ids.has(ref)).toBe(true);
        }
      }
    }
  });

  it('per-filler SEARCH expressions exclude the bare totals', () => {
    const searches = allWidgets()
      .flatMap((w) => w.properties.metrics ?? [])
      .flat()
      .filter((p): p is Exclude<typeof p, string> => typeof p === 'object' && !!p.expression?.startsWith('SEARCH'))
      .map((p) => p.expression as string);
    const perFiller = searches.filter((s) => s.includes('RFQ_TIMEOUT_') || s.includes('RFQ_STRAGGLER_'));
    expect(perFiller.length).toBeGreaterThanOrEqual(2);
    for (const s of perFiller) {
      expect(s).toContain('NOT MetricName=');
    }
  });
});
