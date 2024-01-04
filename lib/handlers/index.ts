import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { QuoteHandler, QuoteInjector } from './quote';
import { SwitchHandler, SwitchInjector } from './synth-switch';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  quoteHandler: quoteHandler.handler,
  switchHandler: switchHandler.handler,
};
