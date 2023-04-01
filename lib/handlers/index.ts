import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { RfqHandler, RfqInjector } from './integration/rfq';
import { MockQuoteInjector, QuoteHandler, QuoteInjector } from './quote';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

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
  mockQuoteHandler: mockQuoteHandler.handler,
  rfqHandler: rfqHandler.handler,
};
