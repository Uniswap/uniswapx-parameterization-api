import { ProtocolVersion, WebhookConfiguration, WebhookConfigurationProvider } from '.';

export class MockWebhookConfigurationProvider implements WebhookConfigurationProvider {
  constructor(private endpoints: WebhookConfiguration[]) {}

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }

  async getFillerSupportedProtocols(endpoint: string): Promise<ProtocolVersion[]> {
    const config = this.endpoints.find((e) => e.endpoint === endpoint);
    return config?.supportedVersions ?? [ProtocolVersion.V1];
  }
}
