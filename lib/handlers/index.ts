import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';
import { RfqHandler, RfqInjector } from './integration/rfq';
import { QuoteHandler, QuoteInjector } from './quote';
import { SwitchHandler, SwitchInjector } from './synth-switch';

const quoteInjectorPromise = new QuoteInjector('quoteInjector').build();
const quoteHandler = new QuoteHandler('quoteHandler', quoteInjectorPromise);

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

const rfqInjectorPromise = new RfqInjector('rfqInjector').build();
const rfqHandler = new RfqHandler('rfqHandler', rfqInjectorPromise);

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  quoteHandler: quoteHandler.handler,
  rfqHandler: rfqHandler.handler,
  switchHandler: switchHandler.handler,
};
