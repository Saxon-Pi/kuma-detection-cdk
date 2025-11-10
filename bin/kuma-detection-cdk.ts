#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KumaDetectionCdkStack } from '../lib/kuma-detection-cdk-stack';
import { NetworkStack } from '../lib/network-stack';

const app = new cdk.App();

const env = {
  region: 'ap-northeast-1',
};

new NetworkStack(app, 'KumaDetection-NetworkStack', { 
  env,
  stackName: 'kuma-detection-network',
});

new KumaDetectionCdkStack(app, 'KumaDetection-AppStack', {
  env,
  stackName: 'kuma-detection-app',
});
