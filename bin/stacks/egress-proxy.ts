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

// Squid is a single process, so one task can use at most one vCPU; this is that ceiling. Two
// gigabytes leaves room for tens of thousands of open tunnels (each holds two sockets and their
// buffers) plus squid's own pools.
const TASK_CPU_UNITS = 1024;
const TASK_MEMORY_MIB = 2048;
// Four tasks spread across the three availability zones carry today's whole webhook volume with
// most of each core to spare; autoscaling adds tasks on sustained CPU up to the maximum and
// removes them slowly once it falls. Removing a task is cheap: the load balancer drains it for
// 30 s, squid finishes in-flight requests before exiting, and callers reconnect idle keep-alive
// tunnels on their own, so only a request in flight at that instant fails.
const MIN_TASKS = 4;
const MAX_TASKS = 12;
const SCALE_OUT_CPU_PERCENT = 50;
const SCALE_IN_COOLDOWN = Duration.minutes(30);
// Alarm thresholds: losing one task is tolerable, losing two is not; CPU this high on average
// means autoscaling is at its maximum or not keeping up. The healthy-hosts alarm waits ten
// minutes so the first deploy, which grows the service from two tasks to the minimum while the
// threshold rises, cannot trip it.
const HEALTHY_TASKS_ALARM_BELOW = MIN_TASKS - 1;
const HEALTHY_TASKS_ALARM_MINUTES = 10;
const CPU_ALARM_PERCENT = 70;
const MEMORY_ALARM_PERCENT = 80;

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
 * Before that, the quote Lambdas route a configured share of their own webhook calls through
 * it (see `proxyUrl`), which proves it on real market-maker traffic first.
 *
 * It does not modify the VPC, subnets, route tables, NAT gateway, or Elastic IP. Remove it once
 * the Elastic IP moves to the backend account at decommission.
 */
export class EgressProxy extends Construct {
  public readonly endpointServiceName: string;
  // How callers inside this VPC reach the proxy: the internal load balancer on the proxy port.
  public readonly proxyUrl: string;

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
      cpu: TASK_CPU_UNITS,
      memoryLimitMiB: TASK_MEMORY_MIB,
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

    // The task count is owned by autoscaling (no desiredCount here, so a deploy leaves the
    // running count alone); the minimum spreads tasks across availability zones so one crash or
    // zone problem does not cut off the backend service's market-maker traffic.
    const service = new aws_ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: privateSubnets,
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
    });
    service.autoScaleTaskCount({ minCapacity: MIN_TASKS, maxCapacity: MAX_TASKS }).scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: SCALE_OUT_CPU_PERCENT,
      scaleOutCooldown: Duration.minutes(1),
      scaleInCooldown: SCALE_IN_COOLDOWN,
    });

    // A PrivateLink endpoint service must front a Network Load Balancer.
    const loadBalancer = new aws_elbv2.NetworkLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: false,
      vpcSubnets: privateSubnets,
      crossZoneEnabled: true,
    });
    this.proxyUrl = `http://${loadBalancer.loadBalancerDnsName}:${EGRESS_PROXY_PORT}`;
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

    const alarms = [
      new aws_cloudwatch.Alarm(this, 'HealthyHostsAlarm', {
        alarmName: 'GoudaParameterization-SEV3-EgressProxy-HealthyHosts',
        alarmDescription: `Fewer than ${HEALTHY_TASKS_ALARM_BELOW} healthy egress proxy tasks; the backend uniswapx market-maker traffic depends on them`,
        metric: targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1), statistic: 'Minimum' }),
        threshold: HEALTHY_TASKS_ALARM_BELOW,
        comparisonOperator: aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: HEALTHY_TASKS_ALARM_MINUTES,
        treatMissingData: aws_cloudwatch.TreatMissingData.BREACHING,
      }),
      new aws_cloudwatch.Alarm(this, 'CpuAlarm', {
        alarmName: 'GoudaParameterization-SEV3-EgressProxy-Cpu',
        alarmDescription: `Egress proxy tasks above ${CPU_ALARM_PERCENT}% CPU on average; autoscaling is at its maximum or not keeping up, and tunnel setup slows down`,
        metric: service.metricCpuUtilization({ period: Duration.minutes(1), statistic: 'Average' }),
        threshold: CPU_ALARM_PERCENT,
        comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new aws_cloudwatch.Alarm(this, 'MemoryAlarm', {
        alarmName: 'GoudaParameterization-SEV3-EgressProxy-Memory',
        alarmDescription: `Egress proxy tasks above ${MEMORY_ALARM_PERCENT}% memory on average; open tunnels are approaching what the tasks can hold`,
        metric: service.metricMemoryUtilization({ period: Duration.minutes(1), statistic: 'Average' }),
        threshold: MEMORY_ALARM_PERCENT,
        comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    if (chatbotTopic) {
      for (const alarm of alarms) {
        alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotTopic));
      }
    }
  }
}
