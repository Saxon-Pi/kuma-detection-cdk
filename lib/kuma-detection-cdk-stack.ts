import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface KumaDetectionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  detectionTable: dynamodb.ITable;
}

export class KumaDetectionCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KumaDetectionStackProps) {
    super(scope, id, props);

    const vpc = props.vpc;
    const table = props.detectionTable;

  }
}
