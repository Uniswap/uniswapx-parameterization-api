import { SwitchHandler } from './handler';
import { SwitchInjector } from './injector';

const switchInjectorPromise = new SwitchInjector('switchInjector').build();
const switchHandler = new SwitchHandler('SwitchHandler', switchInjectorPromise);

module.exports = {
  switchHandler: switchHandler.handler,
};
