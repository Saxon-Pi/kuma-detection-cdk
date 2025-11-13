import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// Dynamo DB スタック
  // DynamoDBでは partitionKey + sortKey の組み合わせが Primary Key となる（テーブルの主キーを構成する特別な属性）
  // partitionKey が同一のレコードは、同じ物理パーティションに記録される
  // -> cameraId が "cam-01" と "cam-02" では、物理パーティションが異なるが、アプリ側からは一つのテーブルに見える
  // sortKey によって物理パーティション内のレコードの順序が決まるイメージ
  // Primary Key 以外はアプリ側の裁量で自由にデータを登録できる
  
export class DynamoStack extends cdk.Stack {
  // 他スタックから参照できるように公開
  public readonly kumaDetectionTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // クマ検知イベント用テーブル
    this.kumaDetectionTable = new dynamodb.Table(this, 'kumaDetectionTable', {
      tableName: 'kumaDetection',
      partitionKey: { 
        name: 'cameraId',   // カメラID: カメラ単位でパーティションを分ける
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'detectedAt', // 検出時間
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // リクエストに応じてお金が掛かる
      stream: dynamodb.StreamViewType.NEW_IMAGE,         // DynamoDBストリーム有効化
      removalPolicy: cdk.RemovalPolicy.DESTROY,          // destroyでテーブルそのものを削除
      pointInTimeRecovery: false,                        // 学習用のため一旦OFF
    });

    // TTLは使用しない
    // this.kumaDetectionTable.addTimeToLiveAttribute('ttl');

    // Tag
    cdk.Tags.of(this.kumaDetectionTable).add('Project', 'KumaDetection');
  }
}
