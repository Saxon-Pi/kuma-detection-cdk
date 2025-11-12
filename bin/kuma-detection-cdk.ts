#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DynamoStack } from '../lib/dynamodb-stack';
import { KumaDetectionCdkStack } from '../lib/kuma-detection-cdk-stack';

const app = new cdk.App();

const env = {
  region: 'ap-northeast-1',
};

const networkStack = new NetworkStack(app, 'KumaDetection-NetworkStack', { 
  env,
  stackName: 'kuma-detection-network',
});

const dynamoStack = new DynamoStack(app, 'KumaDetection-DynamoStack', {
  env,
  stackName: 'kuma-detection-dynamo',
});

new KumaDetectionCdkStack(app, 'KumaDetection-NotificationStack', {
  env,
  vpc: networkStack.vpc,
  detectionTable: dynamoStack.kumaDetectionTable,
  stackName: 'kuma-detection-app',
});
