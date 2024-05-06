import { QuoteHandler } from './handler';
import { QuoteInjector } from './injector';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();

const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

module.exports = {
  quoteHandler: quoteHandler.handler,
};
