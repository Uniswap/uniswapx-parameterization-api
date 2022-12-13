import { handler as quoteRequestProcessor } from './blueprints/cw-log-firehose-processor';
import { QuoteHandler, QuoteInjector } from './quote';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

module.exports = {
  quoteRequestProcessor: quoteRequestProcessor,
  quoteHandler: quoteHandler.handler,
};
