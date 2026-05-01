import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * Write an SSM parameter with a well-known path.
 * Path format: /{prefix}/{key}  e.g. /ClaudeStats-prod/data/table-arns/teams
 */
export function putParam(
  scope: Construct,
  prefix: string,
  key: string,
  value: string,
): ssm.StringParameter {
  return new ssm.StringParameter(scope, `Param-${key.replace(/\//g, "-")}`, {
    parameterName: `/${prefix}/${key}`,
    stringValue: value,
  });
}

/**
 * Read an SSM parameter at deploy time.
 * Returns a CloudFormation token that resolves during deployment.
 */
export function getParam(
  scope: Construct,
  prefix: string,
  key: string,
): string {
  return ssm.StringParameter.valueForStringParameter(
    scope,
    `/${prefix}/${key}`,
  );
}
