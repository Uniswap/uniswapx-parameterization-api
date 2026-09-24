import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NatProvider, Vpc } from 'aws-cdk-lib/aws-ec2';

import { EGRESS_PROXY_BACKEND_ACCOUNTS } from '../../bin/config';
import { EGRESS_PROXY_PORT, EgressProxy } from '../../bin/stacks/egress-proxy';
import { STAGE } from '../../lib/util/stage';

// A VPC shaped like the quote Lambdas' VPC: one NAT gateway on a fixed Elastic IP.
function synth(withProxy: boolean, allowedAccounts: readonly string[] = EGRESS_PROXY_BACKEND_ACCOUNTS[STAGE.BETA]) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Stack', { env: { account: '801328487475', region: 'us-east-2' } });
  const vpc = new Vpc(stack, 'QuoteLambdaVpc', {
    natGateways: 1,
    natGatewayProvider: NatProvider.gateway({ eipAllocationIds: ['eipalloc-0123456789abcdef0'] }),
    maxAzs: 3,
  });
  if (withProxy) new EgressProxy(stack, 'EgressProxy', { vpc, allowedAccounts });
  return Template.fromStack(stack);
}

describe('EgressProxy', () => {
  it('maps the beta proxy to backend dev + staging and the prod proxy to backend prod only', () => {
    expect(EGRESS_PROXY_BACKEND_ACCOUNTS[STAGE.BETA]).toEqual(['411170392337', '413367642260']);
    expect(EGRESS_PROXY_BACKEND_ACCOUNTS[STAGE.PROD]).toEqual(['654200013602']);
  });

  it('adds no networking the quote Lambdas depend on', () => {
    const without = synth(false);
    const withProxy = synth(true);
    for (const type of [
      'AWS::EC2::VPC',
      'AWS::EC2::Subnet',
      'AWS::EC2::RouteTable',
      'AWS::EC2::Route',
      'AWS::EC2::NatGateway',
      'AWS::EC2::EIP',
      'AWS::EC2::InternetGateway',
    ]) {
      expect(Object.keys(withProxy.findResources(type))).toEqual(Object.keys(without.findResources(type)));
    }
  });

  it('runs two private Fargate tasks behind an internal load balancer', () => {
    const template = synth(true);
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network',
      Scheme: 'internal',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: EGRESS_PROXY_PORT,
      Protocol: 'TCP',
    });
  });

  it('only accepts the proxy port, and only from inside the VPC', () => {
    const groups = Object.values(synth(true).findResources('AWS::EC2::SecurityGroup'));
    expect(groups).toHaveLength(1);
    const ingress = groups[0].Properties.SecurityGroupIngress;
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toMatchObject({ IpProtocol: 'tcp', FromPort: EGRESS_PROXY_PORT, ToPort: EGRESS_PROXY_PORT });
    expect(ingress[0].CidrIp).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^QuoteLambdaVpc/), 'CidrBlock'] });
  });

  it('lets exactly the given backend accounts connect over PrivateLink', () => {
    const template = synth(true, EGRESS_PROXY_BACKEND_ACCOUNTS[STAGE.PROD]);
    template.hasResourceProperties('AWS::EC2::VPCEndpointService', { AcceptanceRequired: false });
    template.hasResourceProperties('AWS::EC2::VPCEndpointServicePermissions', {
      AllowedPrincipals: ['arn:aws:iam::654200013602:root'],
    });
  });
});
