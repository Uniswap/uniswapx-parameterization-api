import { QuoteHandler, QuoteInjector } from './quote';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

module.exports = {
  quoteHandler: quoteHandler.handler,
};
