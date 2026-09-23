import { default as bunyan } from 'bunyan';
import { Writable } from 'stream';

import { BunyanLogger } from '../../lib/observability';

type Record_ = Record<string, unknown>;

/** A bunyan logger whose records are captured as objects, at debug level so every line is kept. */
function capturing() {
  const records: Record_[] = [];
  const stream = new Writable({
    objectMode: true,
    write(rec: Record_, _enc, cb) {
      records.push(rec);
      cb();
    },
  });
  const log = bunyan.createLogger({
    name: 'test',
    serializers: bunyan.stdSerializers,
    streams: [{ type: 'raw', stream, level: 'debug' }],
  });
  return { log, records };
}

/** The record minus the per-process fields bunyan stamps, in bunyan's own key order. */
function stable(rec: Record_): string {
  const copy = { ...rec };
  for (const key of ['time', 'pid', 'hostname']) delete copy[key];
  return JSON.stringify(copy);
}

describe('BunyanLogger', () => {
  it('writes the same record for a message-first call as bunyan does for its fields-first call', () => {
    const viaBunyan = capturing();
    viaBunyan.log.info({ bestQuote: 'q', amount: 3 }, 'bestQuote');

    const viaAdapter = capturing();
    new BunyanLogger(viaAdapter.log).info('bestQuote', { bestQuote: 'q' }, { amount: 3 });

    expect(stable(viaAdapter.records[0])).toEqual(stable(viaBunyan.records[0]));
    expect(viaAdapter.records[0]).toMatchObject({ level: bunyan.INFO, msg: 'bestQuote', bestQuote: 'q', amount: 3 });
  });

  it('with an empty message reproduces a fields-only bunyan record byte for byte (the analytics event lines)', () => {
    const viaBunyan = capturing();
    viaBunyan.log.info({ eventType: 'QuoteRequest', body: { requestId: 'r', amount: '1' } });

    const viaAdapter = capturing();
    new BunyanLogger(viaAdapter.log).info('', { eventType: 'QuoteRequest', body: { requestId: 'r', amount: '1' } });

    expect(stable(viaAdapter.records[0])).toEqual(stable(viaBunyan.records[0]));
    expect(viaAdapter.records[0].msg).toEqual('');
  });

  it('puts an Error extra under err, where the standard serializer renders it, and keeps the level', () => {
    const { log, records } = capturing();
    const boom = new Error('boom');
    new BunyanLogger(log).error('failed', boom, { code: 7 });

    expect(records[0]).toMatchObject({ level: bunyan.ERROR, msg: 'failed', code: 7 });
    expect(records[0].err).toMatchObject({ message: 'boom', name: 'Error' });
    expect((records[0].err as Record_).stack).toEqual(expect.stringContaining('boom'));
  });

  it('keeps the wrapped logger bindings; child() inherits them and setDefaultExtra stays on the logger it was set on', () => {
    const { log, records } = capturing();
    const requestBunyan = log.child({ requestId: 'req-1' });
    const request = new BunyanLogger(requestBunyan);
    const child = request.child();
    child.setDefaultExtra({ quoter: 'WebhookQuoter' }, { endpoint: 'e1' });

    child.debug('child line');
    request.info('parent line');
    requestBunyan.info('raw line');

    expect(records[0]).toMatchObject({
      requestId: 'req-1',
      quoter: 'WebhookQuoter',
      endpoint: 'e1',
      msg: 'child line',
    });
    expect(records[1]).toMatchObject({ requestId: 'req-1', msg: 'parent line' });
    expect(records[1]).not.toHaveProperty('quoter');
    // The bunyan logger the adapter wraps is still the one the quote path holds, unchanged.
    expect(records[2]).toMatchObject({ requestId: 'req-1', msg: 'raw line' });
    expect(records[2]).not.toHaveProperty('quoter');
  });
});
