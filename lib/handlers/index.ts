import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { QuoteHandler, QuoteInjector } from './quote';
import { HardQuoteHandler, HardQuoteInjector, IndicativeQuoteHandler, IndicativeQuoteInjector } from './quote-v2';
import { SwitchHandler, SwitchInjector } from './synth-switch';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

const hInjectorPromise = new HardQuoteInjector('hardQuoteInjector').build();
const hQuoteHandler = new HardQuoteHandler('hardQuoteHandler', hInjectorPromise);

const iInjectorPromise = new IndicativeQuoteInjector('indicativeQuoteInjector').build();
const iQuoteHandler = new IndicativeQuoteHandler('indicativeQuoteHandler', iInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  quoteHandler: quoteHandler.handler,
  switchHandler: switchHandler.handler,
  hQuoteHandler: hQuoteHandler.handler,
  iQuoteHandler: iQuoteHandler.handler,
};
