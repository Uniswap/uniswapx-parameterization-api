import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { RfqHandler, RfqInjector } from './integration/rfq';
import { MockQuoteInjector, QuoteHandler, QuoteInjector } from './quote';
import { HardQuoteHandler, HardQuoteInjector } from './quote-v2/hard';
import { IndicativeQuoteHandler, IndicativeQuoteInjector } from './quote-v2/indicative';
import { SwitchHandler, SwitchInjector } from './synth-switch';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

const mockQuoteInjectorPromise = new MockQuoteInjector('integrationQuoteInjector').build();
const mockQuoteHandler = new QuoteHandler('mockQuoteHandler', mockQuoteInjectorPromise);

const rfqInjectorPromise = new RfqInjector('rfqInjector').build();
const rfqHandler = new RfqHandler('rfqHandler', rfqInjectorPromise);

const iQuoteInjectorPromise = new IndicativeQuoteInjector('iQuoteInjector').build();
const iQuoteHandler = new IndicativeQuoteHandler('iQuoteHandler', iQuoteInjectorPromise);

const hQuoteInjectorPromise = new HardQuoteInjector('hQuoteInjector').build();
const hQuoteHandler = new HardQuoteHandler('hQuoteHandler', hQuoteInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  quoteHandler: quoteHandler.handler,
  mockQuoteHandler: mockQuoteHandler.handler,
  rfqHandler: rfqHandler.handler,
  switchHandler: switchHandler.handler,
  indicativeQuoteHandler: iQuoteHandler.handler,
  hardQuoteHandler: hQuoteHandler.handler,
};
