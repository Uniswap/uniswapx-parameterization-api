import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { HardQuoteHandler, HardQuoteInjector } from './hard-quote';
import { RfqHandler, RfqInjector } from './integration/rfq';
import { MockQuoteInjector, QuoteHandler, QuoteInjector } from './quote';
import { SwitchHandler, SwitchInjector } from './synth-switch';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

const hardQuoteInjectorPromise = new HardQuoteInjector('hardQuoteInjector').build();
const hardQuoteHandler = new HardQuoteHandler('hardQuoteHandler', hardQuoteInjectorPromise);

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

const mockQuoteInjectorPromise = new MockQuoteInjector('integrationQuoteInjector').build();
const mockQuoteHandler = new QuoteHandler('mockQuoteHandler', mockQuoteInjectorPromise);

const rfqInjectorPromise = new RfqInjector('rfqInjector').build();
const rfqHandler = new RfqHandler('rfqHandler', rfqInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  quoteHandler: quoteHandler.handler,
  hardQuoteHandler: hardQuoteHandler.handler,
  mockQuoteHandler: mockQuoteHandler.handler,
  rfqHandler: rfqHandler.handler,
  switchHandler: switchHandler.handler,
};
