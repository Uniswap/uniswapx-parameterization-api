import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
} from './blueprints/cw-log-firehose-processor';

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
};
