import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

// StackPropsの拡張
export interface KumaDetectionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  detectionTable: dynamodb.ITable; // DynamoDB テーブルを使用
}

// クマを検知したときに通知を送信する処理のスタック
// ① DynamoDB にレコードが登録される
// ② DynamoDB streams によってSNS通知用 Lambda が起動する
// ③ SNSトピックに登録されたメールアドレス宛に通知が送信される

export class KumaDetectionCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KumaDetectionStackProps) {
    super(scope, id, props);

    // SNSトピックの作成
    const kumaAlertTopic = new sns.Topic(this, 'kumaAlertTopic', {
      topicName: 'kuma-detection-alert',
      displayName: 'Kuma Detection Alert',
    });

    // メール通知をするアドレスを指定（コンソール上で行うためコメントアウト）
    // alertTopic.addSubscription(new subscriptions.EmailSubscription('<メールアドレス>'));

    // SNS通知用Lambda
    const notifierFunction = new lambda.Function(this, 'kumaDetectionNotifier', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/kuma-notifier'), // デプロイ用コードのパス
      environment: {
        TABLE_NAME: props.detectionTable.tableName, // DynamoDB テーブル名
        TOPIC_ARN: kumaAlertTopic.topicArn,         // SNS トピックARN
      },
    });

    // Lambda イベントの追加（DB streams をトリガーに起動）
    notifierFunction.addEventSource(
      new DynamoEventSource(props.detectionTable, {       // DynamoDB のイベント
        startingPosition: lambda.StartingPosition.LATEST, // これから発生したイベントだけ処理（既存のレコードには反応しない）
        batchSize: 10,    // 一度のLamnda呼び出しで 最大何件のレコードをまとめて渡すか
        retryAttempts: 2, // 失敗後のリトライ回数
      }),
    );

    // Lambda DB Streams 読み取り権限
    props.detectionTable.grantStreamRead(notifierFunction);
    // SNS publish 権限
    kumaAlertTopic.grantPublish(notifierFunction);
  }
}
