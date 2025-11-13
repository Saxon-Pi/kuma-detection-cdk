import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

// StackPropsの拡張
export interface KumaDetectionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  detectionTable: dynamodb.ITable; // DynamoDB テーブルを使用
}

// クマを検知したときに通知を送信する処理のスタック
// . Rekognition Video の出力情報を Kinesis Data Streams で転送
// . ストリーミングデータを Lambda に入力
// . DynamoDB にレコードが登録される
// . DynamoDB streams によってSNS通知用 Lambda が起動する
// . SNSトピックに登録されたメールアドレス宛に通知が送信される

// Kinesis Data Streams テストコマンド（CLI 実行）
/*
aws kinesis put-record \
  --stream-name kuma-detection-stream \
  --partition-key cam-01 \
  --cli-binary-format raw-in-base64-out \
  --data '{"cameraId":"cam-01","detectedAt":"2025-11-13T12:34:56Z","species":"kuma","confidence":0.91,"kumaCount":3}'
*/

export class KumaDetectionCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KumaDetectionStackProps) {
    super(scope, id, props);

    // Kinesis Data Stream（Rekognition によるクマ検知結果を転送） 
    const detectionStream = new kinesis.Stream(this, 'KumaDetectionStream', {
      streamName: 'kuma-detection-stream',
      shardCount: 1, // 1シャード
    });

    // Kinesis のストリーミングデータを DynamoDB に登録する Lambda
    const kinesisConsumerFunction = new lambda.Function(this, 'KinesisToDynamoFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/kinesis-to-dynamo'),
      environment: {
        TABLE_NAME: props.detectionTable.tableName, // DynamoDB テーブル名
      },
    });

    // Kinesis Data Stream を Lambda のイベントソースとする
    kinesisConsumerFunction.addEventSource(
      new KinesisEventSource(detectionStream, {
        startingPosition: lambda.StartingPosition.LATEST, // これから発生したイベントだけ処理（既存のレコードには反応しない）
        batchSize: 10,    // 一度のLamnda呼び出しで 最大何件のレコードをまとめて渡すか
        retryAttempts: 2, // 失敗後のリトライ回数
      }),
    );

    // DynamoDB に書き込む権限を Lambda に付与
    props.detectionTable.grantWriteData(kinesisConsumerFunction);

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

    // DB streams を Lambda のイベントソースとする
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
