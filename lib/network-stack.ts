import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

// VPC 作成スタック
// Public + Private を 2AZ で構成 (NAT Gateway はおあずけ)

export class NetworkStack extends cdk.Stack {
  // 他のスタックから参照できるように公開
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'KumaDetectionVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,      // public, private のサブネットを二つずつ作成
      natGateways: 0, // NAT Gateway ナシ

      subnetConfiguration: [
        {
          name: 'public-kuma',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private-kuma',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // NATナシの純粋プライベートなサブネット
          cidrMask: 24,
        },
      ],
    });

    // Tag
    cdk.Tags.of(this.vpc).add('Project', 'KumaDetection');
  }
}
