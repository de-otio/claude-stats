import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { getParam } from "../ssm-params.js";

interface MonitoringStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

/** Table names matching the keys used in DataStack SSM parameters. */
const TABLE_NAMES = [
  "userProfiles",
  "teams",
  "teamMemberships",
  "syncedSessions",
  "syncedMessages",
  "teamStats",
  "achievements",
  "challenges",
  "interTeamChallenges",
  "magicLinkTokens",
] as const;

export class MonitoringStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, { ...props, description: "Claude Stats monitoring — CloudWatch dashboard, alarms, SNS notifications" });
    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;
    const isProd = config.envName === "prod";

    // ── Read SSM parameters from upstream stacks ──────────────────────

    const graphqlApiId = getParam(this, prefix, "api/graphql-api-id");
    const dlqUrl = getParam(this, prefix, "api/dlq-url");
    const sesConfigSetName = getParam(
      this,
      prefix,
      "auth/ses-configuration-set",
    );

    const tableNames: Record<string, string> = {};
    for (const name of TABLE_NAMES) {
      tableNames[name] = getParam(this, prefix, `data/table-names/${name}`);
    }

    // ── SNS Topic for Alarm Notifications ─────────────────────────────

    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `${prefix}-Alarms`,
      displayName: `${prefix} CloudWatch Alarms`,
    });

    if (config.alarmEmailSsmPath) {
      const email = ssm.StringParameter.valueForStringParameter(
        this,
        config.alarmEmailSsmPath,
      );
      alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(email),
      );
    }

    this.alarmTopic = alarmTopic;

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    // ── CloudWatch Dashboard ──────────────────────────────────────────

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `${prefix}-Dashboard`,
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    // ── Row 1: AppSync API Health ─────────────────────────────────────

    const appSyncNamespace = "AWS/AppSync";
    const apiDimensions = { GraphQLAPIId: graphqlApiId };

    const appSyncLatencyWidget = new cloudwatch.GraphWidget({
      title: "AppSync Latency",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "Latency",
          dimensionsMap: apiDimensions,
          statistic: "p50",
          label: "p50",
        }),
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "Latency",
          dimensionsMap: apiDimensions,
          statistic: "p90",
          label: "p90",
        }),
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "Latency",
          dimensionsMap: apiDimensions,
          statistic: "p99",
          label: "p99",
        }),
      ],
    });

    const appSyncErrorsWidget = new cloudwatch.GraphWidget({
      title: "AppSync Errors",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "4XXError",
          dimensionsMap: apiDimensions,
          statistic: "Sum",
          label: "4XX Errors",
        }),
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "5XXError",
          dimensionsMap: apiDimensions,
          statistic: "Sum",
          label: "5XX Errors",
        }),
      ],
    });

    const appSyncRequestsWidget = new cloudwatch.GraphWidget({
      title: "AppSync Requests",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "4XXError",
          dimensionsMap: apiDimensions,
          statistic: "Sum",
          label: "4XX",
        }),
        new cloudwatch.Metric({
          namespace: appSyncNamespace,
          metricName: "5XXError",
          dimensionsMap: apiDimensions,
          statistic: "Sum",
          label: "5XX",
        }),
      ],
    });

    dashboard.addWidgets(
      appSyncLatencyWidget,
      appSyncErrorsWidget,
      appSyncRequestsWidget,
    );

    // ── Row 2: Lambda Compute ─────────────────────────────────────────

    const lambdaNamespace = "AWS/Lambda";

    const lambdaDurationWidget = new cloudwatch.GraphWidget({
      title: "Lambda Duration",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Duration",
          dimensionsMap: {
            FunctionName: `${prefix}-aggregate-stats`,
          },
          statistic: "p90",
          label: "aggregate-stats p90",
        }),
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Duration",
          dimensionsMap: {
            FunctionName: `${prefix}-team-dashboard`,
          },
          statistic: "p90",
          label: "team-dashboard p90",
        }),
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Duration",
          dimensionsMap: {
            FunctionName: `${prefix}-inter-team-scoring`,
          },
          statistic: "p90",
          label: "inter-team-scoring p90",
        }),
      ],
    });

    const lambdaErrorsWidget = new cloudwatch.GraphWidget({
      title: "Lambda Errors",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Errors",
          dimensionsMap: {
            FunctionName: `${prefix}-aggregate-stats`,
          },
          statistic: "Sum",
          label: "aggregate-stats",
        }),
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Errors",
          dimensionsMap: {
            FunctionName: `${prefix}-team-dashboard`,
          },
          statistic: "Sum",
          label: "team-dashboard",
        }),
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "Errors",
          dimensionsMap: {
            FunctionName: `${prefix}-inter-team-scoring`,
          },
          statistic: "Sum",
          label: "inter-team-scoring",
        }),
      ],
    });

    const lambdaConcurrencyWidget = new cloudwatch.GraphWidget({
      title: "Lambda Concurrent Executions",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "ConcurrentExecutions",
          dimensionsMap: {
            FunctionName: `${prefix}-aggregate-stats`,
          },
          statistic: "Maximum",
          label: "aggregate-stats",
        }),
      ],
    });

    dashboard.addWidgets(
      lambdaDurationWidget,
      lambdaErrorsWidget,
      lambdaConcurrencyWidget,
    );

    // ── Row 3: DynamoDB Data ──────────────────────────────────────────

    const dynamoNamespace = "AWS/DynamoDB";

    // Consumed capacity per table
    const dynamoReadCapacityMetrics: cloudwatch.IMetric[] = [];
    const dynamoWriteCapacityMetrics: cloudwatch.IMetric[] = [];
    const dynamoThrottleMetrics: cloudwatch.IMetric[] = [];

    for (const name of TABLE_NAMES) {
      dynamoReadCapacityMetrics.push(
        new cloudwatch.Metric({
          namespace: dynamoNamespace,
          metricName: "ConsumedReadCapacityUnits",
          dimensionsMap: { TableName: tableNames[name] },
          statistic: "Sum",
          label: name,
        }),
      );
      dynamoWriteCapacityMetrics.push(
        new cloudwatch.Metric({
          namespace: dynamoNamespace,
          metricName: "ConsumedWriteCapacityUnits",
          dimensionsMap: { TableName: tableNames[name] },
          statistic: "Sum",
          label: name,
        }),
      );
      dynamoThrottleMetrics.push(
        new cloudwatch.Metric({
          namespace: dynamoNamespace,
          metricName: "ThrottledRequests",
          dimensionsMap: { TableName: tableNames[name] },
          statistic: "Sum",
          label: name,
        }),
      );
    }

    const dynamoReadWidget = new cloudwatch.GraphWidget({
      title: "DynamoDB Read Capacity",
      width: 8,
      height: 6,
      left: dynamoReadCapacityMetrics,
    });

    const dynamoWriteWidget = new cloudwatch.GraphWidget({
      title: "DynamoDB Write Capacity",
      width: 8,
      height: 6,
      left: dynamoWriteCapacityMetrics,
    });

    const dynamoThrottleWidget = new cloudwatch.GraphWidget({
      title: "DynamoDB Throttled Requests",
      width: 8,
      height: 6,
      left: dynamoThrottleMetrics,
    });

    dashboard.addWidgets(
      dynamoReadWidget,
      dynamoWriteWidget,
      dynamoThrottleWidget,
    );

    // ── Row 4: Streams, DLQ & Billing ─────────────────────────────────

    const iteratorAgeWidget = new cloudwatch.GraphWidget({
      title: "DynamoDB Streams Iterator Age",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: lambdaNamespace,
          metricName: "IteratorAge",
          dimensionsMap: {
            FunctionName: `${prefix}-aggregate-stats`,
          },
          statistic: "Maximum",
          label: "Iterator Age (ms)",
        }),
      ],
    });

    const dlqWidget = new cloudwatch.SingleValueWidget({
      title: "DLQ Messages",
      width: 8,
      height: 6,
      metrics: [
        new cloudwatch.Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: `${prefix}-aggregate-stats-dlq` },
          statistic: "Maximum",
          label: "Visible Messages",
        }),
      ],
    });

    const billingWidget = new cloudwatch.GraphWidget({
      title: "Estimated Monthly Charges",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/Billing",
          metricName: "EstimatedCharges",
          dimensionsMap: { Currency: "USD" },
          statistic: "Maximum",
          label: "Estimated Charges (USD)",
          period: cdk.Duration.hours(6),
        }),
      ],
    });

    dashboard.addWidgets(iteratorAgeWidget, dlqWidget, billingWidget);

    // ── Row 5: SES Email Delivery ─────────────────────────────────────

    const sesNamespace = "AWS/SES";
    const sesConfigSetDimensions = { "ses:configuration-set": sesConfigSetName };

    const sesDeliveryWidget = new cloudwatch.GraphWidget({
      title: "SES Sends & Deliveries",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Send",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Sum",
          label: "Sends",
        }),
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Delivery",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Sum",
          label: "Deliveries",
        }),
      ],
    });

    const sesBounceWidget = new cloudwatch.GraphWidget({
      title: "SES Bounces & Complaints",
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Bounce",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Sum",
          label: "Bounces",
        }),
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Complaint",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Sum",
          label: "Complaints",
        }),
      ],
    });

    const sesReputationWidget = new cloudwatch.SingleValueWidget({
      title: "SES Reputation",
      width: 8,
      height: 6,
      metrics: [
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Reputation.BounceRate",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Average",
          label: "Bounce Rate",
        }),
        new cloudwatch.Metric({
          namespace: sesNamespace,
          metricName: "Reputation.ComplaintRate",
          dimensionsMap: sesConfigSetDimensions,
          statistic: "Average",
          label: "Complaint Rate",
        }),
      ],
    });

    dashboard.addWidgets(sesDeliveryWidget, sesBounceWidget, sesReputationWidget);

    // ── Alarms (prod only) ────────────────────────────────────────────

    if (isProd) {
      // AppSync 5xx error rate > 1% for 5 min
      const appSync5xxAlarm = new cloudwatch.Alarm(this, "AppSync5xxAlarm", {
        alarmName: `${prefix}-AppSync-5xx-ErrorRate`,
        alarmDescription:
          "AppSync 5xx error rate exceeds 1% for 5 minutes",
        metric: new cloudwatch.MathExpression({
          expression: "errors / (errors + successes) * 100",
          usingMetrics: {
            errors: new cloudwatch.Metric({
              namespace: appSyncNamespace,
              metricName: "5XXError",
              dimensionsMap: apiDimensions,
              statistic: "Sum",
              period: cdk.Duration.minutes(5),
            }),
            successes: new cloudwatch.Metric({
              namespace: appSyncNamespace,
              metricName: "Latency",
              dimensionsMap: apiDimensions,
              statistic: "SampleCount",
              period: cdk.Duration.minutes(5),
            }),
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      appSync5xxAlarm.addAlarmAction(alarmAction);
      appSync5xxAlarm.addOkAction(alarmAction);

      // Lambda error rate > 5% for 5 min
      const lambdaErrorAlarm = new cloudwatch.Alarm(
        this,
        "LambdaErrorRateAlarm",
        {
          alarmName: `${prefix}-Lambda-ErrorRate`,
          alarmDescription:
            "Lambda error rate exceeds 5% for 5 minutes",
          metric: new cloudwatch.MathExpression({
            expression: "errors / invocations * 100",
            usingMetrics: {
              errors: new cloudwatch.Metric({
                namespace: lambdaNamespace,
                metricName: "Errors",
                statistic: "Sum",
                period: cdk.Duration.minutes(5),
              }),
              invocations: new cloudwatch.Metric({
                namespace: lambdaNamespace,
                metricName: "Invocations",
                statistic: "Sum",
                period: cdk.Duration.minutes(5),
              }),
            },
            period: cdk.Duration.minutes(5),
          }),
          threshold: 5,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      lambdaErrorAlarm.addAlarmAction(alarmAction);
      lambdaErrorAlarm.addOkAction(alarmAction);

      // DynamoDB throttled requests > 0 for 5 min
      // Use a math expression to sum throttles across all tables
      const throttleUsingMetrics: Record<string, cloudwatch.IMetric> = {};
      const throttleExpressionParts: string[] = [];
      for (let i = 0; i < TABLE_NAMES.length; i++) {
        const metricId = `t${i}`;
        throttleExpressionParts.push(metricId);
        throttleUsingMetrics[metricId] = new cloudwatch.Metric({
          namespace: dynamoNamespace,
          metricName: "ThrottledRequests",
          dimensionsMap: { TableName: tableNames[TABLE_NAMES[i]] },
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        });
      }

      const dynamoThrottleAlarm = new cloudwatch.Alarm(
        this,
        "DynamoDBThrottleAlarm",
        {
          alarmName: `${prefix}-DynamoDB-Throttled`,
          alarmDescription:
            "DynamoDB throttled requests detected for 5 minutes",
          metric: new cloudwatch.MathExpression({
            expression: throttleExpressionParts.join(" + "),
            usingMetrics: throttleUsingMetrics,
            period: cdk.Duration.minutes(5),
          }),
          threshold: 0,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      dynamoThrottleAlarm.addAlarmAction(alarmAction);
      dynamoThrottleAlarm.addOkAction(alarmAction);

      // DynamoDB Streams iterator age > 5 min (300,000 ms)
      const iteratorAgeAlarm = new cloudwatch.Alarm(
        this,
        "StreamIteratorAgeAlarm",
        {
          alarmName: `${prefix}-Stream-IteratorAge`,
          alarmDescription:
            "DynamoDB Streams iterator age exceeds 5 minutes",
          metric: new cloudwatch.Metric({
            namespace: lambdaNamespace,
            metricName: "IteratorAge",
            dimensionsMap: {
              FunctionName: `${prefix}-aggregate-stats`,
            },
            statistic: "Maximum",
            period: cdk.Duration.minutes(5),
          }),
          threshold: 300_000, // 5 minutes in milliseconds
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      iteratorAgeAlarm.addAlarmAction(alarmAction);
      iteratorAgeAlarm.addOkAction(alarmAction);

      // DLQ messages > 0
      const dlqAlarm = new cloudwatch.Alarm(this, "DLQMessagesAlarm", {
        alarmName: `${prefix}-DLQ-Messages`,
        alarmDescription:
          "Dead letter queue has visible messages — inspect aggregate-stats failures",
        metric: new cloudwatch.Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: `${prefix}-aggregate-stats-dlq` },
          statistic: "Maximum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      dlqAlarm.addAlarmAction(alarmAction);
      dlqAlarm.addOkAction(alarmAction);

      // Monthly charges > config.monthlyBudgetUsd
      const billingAlarm = new cloudwatch.Alarm(this, "BillingAlarm", {
        alarmName: `${prefix}-Monthly-Charges`,
        alarmDescription: `Estimated monthly charges exceed $${config.monthlyBudgetUsd} budget`,
        metric: new cloudwatch.Metric({
          namespace: "AWS/Billing",
          metricName: "EstimatedCharges",
          dimensionsMap: { Currency: "USD" },
          statistic: "Maximum",
          period: cdk.Duration.hours(6),
        }),
        threshold: config.monthlyBudgetUsd,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      billingAlarm.addAlarmAction(alarmAction);
      billingAlarm.addOkAction(alarmAction);

      // SES bounce rate > 5% (AWS suspends at 10%)
      const sesBounceRateAlarm = new cloudwatch.Alarm(
        this,
        "SesBounceRateAlarm",
        {
          alarmName: `${prefix}-SES-BounceRate`,
          alarmDescription:
            "SES bounce rate exceeds 5% — review recipient list quality (AWS suspends at 10%)",
          metric: new cloudwatch.Metric({
            namespace: sesNamespace,
            metricName: "Reputation.BounceRate",
            dimensionsMap: sesConfigSetDimensions,
            statistic: "Average",
            period: cdk.Duration.minutes(15),
          }),
          threshold: 0.05,
          evaluationPeriods: 2,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      sesBounceRateAlarm.addAlarmAction(alarmAction);
      sesBounceRateAlarm.addOkAction(alarmAction);

      // SES complaint rate > 0.1% (AWS suspends at 0.5%)
      const sesComplaintRateAlarm = new cloudwatch.Alarm(
        this,
        "SesComplaintRateAlarm",
        {
          alarmName: `${prefix}-SES-ComplaintRate`,
          alarmDescription:
            "SES complaint rate exceeds 0.1% — review email content and opt-in (AWS suspends at 0.5%)",
          metric: new cloudwatch.Metric({
            namespace: sesNamespace,
            metricName: "Reputation.ComplaintRate",
            dimensionsMap: sesConfigSetDimensions,
            statistic: "Average",
            period: cdk.Duration.minutes(15),
          }),
          threshold: 0.001,
          evaluationPeriods: 2,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );
      sesComplaintRateAlarm.addAlarmAction(alarmAction);
      sesComplaintRateAlarm.addOkAction(alarmAction);
    }

    this.dashboard = dashboard;

    // ── Log Retention (informational output) ──────────────────────────

    new cdk.CfnOutput(this, "LogRetentionDays", {
      value: String(config.logRetentionDays),
      description: "Log retention period for this environment",
    });

    new cdk.CfnOutput(this, "DashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${prefix}-Dashboard`,
      description: "CloudWatch Dashboard URL",
    });

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value: alarmTopic.topicArn,
      description: "SNS topic ARN for alarm notifications",
    });
  }
}
