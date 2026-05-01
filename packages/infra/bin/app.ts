#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { ClaudeStatsApp } from "../lib/index.js";
import { devConfig } from "../lib/config/dev.js";
import { prodConfig } from "../lib/config/prod.js";

const app = new cdk.App();
const envName =
  (app.node.tryGetContext("env") as "dev" | "prod") ?? "dev";
const config = envName === "prod" ? prodConfig : devConfig;

new ClaudeStatsApp(app, `ClaudeStats-${config.envName}`, {
  envName: config.envName,
  account: config.account,
  region: config.region,
  senderEmail: config.senderEmail,
  allowedEmailDomains: config.allowedEmailDomains,
  domainName: config.domainName,
  parentZoneName: config.parentZoneName,
  parentZoneId: config.parentZoneId,
  configOverrides: config,
});
