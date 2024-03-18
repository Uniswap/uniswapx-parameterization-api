import { QuoteHandler } from './handler';
import { MockQuoteInjector, QuoteInjector } from './injector';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const mockQuoteInjectorPromise = new MockQuoteInjector('integrationQuoteInjector').build();

const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);
const mockQuoteHandler = new QuoteHandler('mockQuoteHandler', mockQuoteInjectorPromise);

module.exports = {
  quoteHandler: quoteHandler.handler,
  mockQuoteHandler: mockQuoteHandler.handler,
};
