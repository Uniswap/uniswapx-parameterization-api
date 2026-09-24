import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as aws_ecs from 'aws-cdk-lib/aws-ecs';
import * as aws_elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export const EGRESS_PROXY_PORT = 3128;

export interface EgressProxyProps {
  // The quote Lambdas' VPC. Its single NAT gateway carries the Elastic IP market makers allowlist.
  vpc: aws_ec2.IVpc;
  // Backend accounts allowed to connect to the proxy over PrivateLink.
  allowedAccounts: readonly string[];
  chatbotTopic?: cdk.aws_sns.ITopic;
}

/**
 * Egress bridge for the monorepo migration. The backend `uniswapx` service connects over
 * PrivateLink and sends its market-maker webhook calls through this forward proxy, so they
 * leave through this VPC's NAT gateway and keep the Elastic IP market makers allowlist. Both
 * stacks then share one egress IP, and moving trading between them needs no allowlist change.
 *
 * Purely additive: the quote Lambdas never use it, and it does not modify the VPC, subnets,
 * route tables, NAT gateway, or Elastic IP. Remove it once the Elastic IP moves to the backend
 * account at decommission.
 */
export class EgressProxy extends Construct {
  public readonly endpointServiceName: string;

  constructor(scope: Construct, id: string, props: EgressProxyProps) {
    super(scope, id);
    const { vpc, allowedAccounts, chatbotTopic } = props;
    const privateSubnets = { subnetType: aws_ec2.SubnetType.PRIVATE_WITH_EGRESS };

    const cluster = new aws_ecs.Cluster(this, 'Cluster', { vpc });

    const logGroup = new aws_logs.LogGroup(this, 'Logs', {
      retention: aws_logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new aws_ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: aws_ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: aws_ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer('Squid', {
      image: aws_ecs.ContainerImage.fromAsset(path.join(__dirname, 'egress-proxy-image'), {
        platform: Platform.LINUX_AMD64,
      }),
      portMappings: [{ containerPort: EGRESS_PROXY_PORT }],
      logging: aws_ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'egress-proxy' }),
    });

    // Load-balancer and PrivateLink traffic arrive from the load balancer's private IPs.
    const securityGroup = new aws_ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Egress proxy for the backend uniswapx market-maker webhook calls',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      aws_ec2.Peer.ipv4(vpc.vpcCidrBlock),
      aws_ec2.Port.tcp(EGRESS_PROXY_PORT),
      'Load balancer and PrivateLink traffic'
    );

    // Two tasks, spread across availability zones, so one crash or zone problem does not cut
    // off the backend service's market-maker traffic.
    const service = new aws_ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: privateSubnets,
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
    });

    // A PrivateLink endpoint service must front a Network Load Balancer.
    const loadBalancer = new aws_elbv2.NetworkLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: false,
      vpcSubnets: privateSubnets,
      crossZoneEnabled: true,
    });
    const targetGroup = loadBalancer
      .addListener('Listener', { port: EGRESS_PROXY_PORT, protocol: aws_elbv2.Protocol.TCP })
      .addTargets('Targets', {
        port: EGRESS_PROXY_PORT,
        protocol: aws_elbv2.Protocol.TCP,
        targets: [service],
        deregistrationDelay: Duration.seconds(30),
        healthCheck: {
          protocol: aws_elbv2.Protocol.TCP,
          interval: Duration.seconds(10),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
        },
      });

    // Principals here may create endpoints (the backend deploy roles); which workloads can use
    // an endpoint is controlled by the endpoint's security group on the backend side.
    const endpointService = new aws_ec2.VpcEndpointService(this, 'EndpointService', {
      vpcEndpointServiceLoadBalancers: [loadBalancer],
      acceptanceRequired: false,
      allowedPrincipals: allowedAccounts.map((account) => new aws_iam.ArnPrincipal(`arn:aws:iam::${account}:root`)),
    });
    this.endpointServiceName = endpointService.vpcEndpointServiceName;

    const healthyHostsAlarm = new aws_cloudwatch.Alarm(this, 'HealthyHostsAlarm', {
      alarmName: 'GoudaParameterization-SEV3-EgressProxy-HealthyHosts',
      alarmDescription:
        'Fewer than two healthy egress proxy tasks; the backend uniswapx market-maker traffic depends on them',
      metric: targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 2,
      comparisonOperator: aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 5,
      treatMissingData: aws_cloudwatch.TreatMissingData.BREACHING,
    });
    if (chatbotTopic) {
      healthyHostsAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotTopic));
    }
  }
}
