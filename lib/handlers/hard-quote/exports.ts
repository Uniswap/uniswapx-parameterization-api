import { QuoteHandler } from './handler';
import { QuoteInjector } from './injector';

const hardQuoteInjectorPromise = new QuoteInjector('hardQuoteInjector').build();
const hardQuoteHandler = new QuoteHandler('hardQuoteHandler', hardQuoteInjectorPromise);

module.exports = {
  hardQuoteHandler: hardQuoteHandler.handler,
};
