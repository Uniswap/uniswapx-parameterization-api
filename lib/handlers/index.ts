import { fillEventProcessor, quoteProcessor } from './blueprints/cw-log-firehose-processor';
import { QuoteHandler, QuoteInjector } from './quote';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  quoteProcessor: quoteProcessor,
  quoteHandler: quoteHandler.handler,
};
