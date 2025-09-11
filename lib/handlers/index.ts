import {
  botOrderEventsProcessor,
  fillEventProcessor,
  postOrderProcessor,
  quoteProcessor,
  unimindResponseProcessor,
  unimindParameterUpdateProcessor,
} from './blueprints/cw-log-firehose-processor';

module.exports = {
  fillEventProcessor: fillEventProcessor,
  postOrderProcessor: postOrderProcessor,
  quoteProcessor: quoteProcessor,
  botOrderEventsProcessor: botOrderEventsProcessor,
  unimindResponseProcessor: unimindResponseProcessor,
  unimindParameterUpdateProcessor: unimindParameterUpdateProcessor,
};
