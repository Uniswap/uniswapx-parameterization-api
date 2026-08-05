import {
  BASELINE_E2E_P50_MS,
  E2EByChainWidgets,
  FanoutByChainWidgets,
  LambdaWidget,
  PhaseDecompositionWidgets,
  StoryRowWidgets,
  WastedWaitWidgets,
} from '../../bin/stacks/param-dashboard-stack';

const REGION = 'us-east-2';

const allWidgets = (): LambdaWidget[] => [
  ...StoryRowWidgets(REGION),
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

  it('story headline carries the frozen baseline annotations', () => {
    const headline = StoryRowWidgets(REGION)[0];
    const annotations = headline.properties.annotations?.horizontal ?? [];
    expect(annotations.some((a) => a.value === BASELINE_E2E_P50_MS && a.label?.includes('baseline'))).toBe(true);
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
        const referenced = e.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
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
