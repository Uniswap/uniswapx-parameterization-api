import { RfqHandler } from './handler';
import { RfqInjector } from './injector';

const rfqInjectorPromise = new RfqInjector('rfqInjector').build();
const rfqHandler = new RfqHandler('rfqHandler', rfqInjectorPromise);

module.exports = {
  rfqHandler: rfqHandler.handler,
};
