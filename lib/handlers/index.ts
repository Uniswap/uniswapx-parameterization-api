import { HelloWorldHandler, HelloWorldInjector } from './hello-world';

const helloWorldInjectorPromise = new HelloWorldInjector('helloWorldInjector').build();
const helloWorldHandler = new HelloWorldHandler('helloWorldHandler', helloWorldInjectorPromise);

module.exports = {
  helloWorldHandler: helloWorldHandler.handler,
};
