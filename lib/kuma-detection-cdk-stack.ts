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
import * as kinesisvideo from 'aws-cdk-lib/aws-kinesisvideo';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

// StackPropsの拡張
export interface KumaDetectionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  detectionTable: dynamodb.ITable; // DynamoDB テーブルを使用
}

// クマを検出したときに通知を送信する処理のスタック
// . カメラからの映像を Kinesis Video Streams でストリーミング
// . ストリーミングされた映像からフレーム抽出 & クマ検出（EventBridge + Lambda + Rekognition）
// . 検出結果を Kinesis Data Streams でストリーミング
// . ストリーミングデータを Lambda で処理し DynamoDB にレコードを登録する
// . DynamoDB streams を Lambda で処理し クマを検出した場合は SNS でメール通知
// . SNSトピックに登録されたメールアドレス宛にメッセージが送信される

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

    // Kinesis Video Stream
    const videoStream = new kinesisvideo.CfnStream(this, 'KumaVideoStream', {
      name: 'kuma-detection-video-stream',
      dataRetentionInHours: 24, // 映像解析用のバッファ期間
    });

    // Kinesis Data Stream（Rekognition によるクマ検出結果を転送） 
    const detectionStream = new kinesis.Stream(this, 'KumaDetectionStream', {
      streamName: 'kuma-detection-stream',
      shardCount: 1, // 1シャード
    });

    // Rekognition 用のロール
    const rekognitionRole = new iam.Role(this, 'RekognitionStreamProcessorRole', {
      assumedBy: new iam.ServicePrincipal('rekognition.amazonaws.com'),
    });

    // Rekognition Role に Kinesis Video Stream から映像を読み込むための権限を追加
    rekognitionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kinesisvideo:GetDataEndpoint',
        'kinesisvideo:GetMedia',
      ],
      resources: [videoStream.attrArn],
    }));

    // Rekognition Role に Kinesis Data Streams へ検出結果を送信するための権限を追加
    rekognitionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
      resources: [detectionStream.streamArn],
    }));

    // フレーム抽出 & Rekognition 実行用 Lambda
    // Kinesis Video Streams -> Lambda -> Kinesis Data Streams
    const frameExtractorFunction = new lambda.Function(this, 'KumaFrameExtractorFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/frame-extractor'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        VIDEO_STREAM_ARN: videoStream.attrArn,              // Kinesis Video Streams ARN
        DETECTION_STREAM_NAME: detectionStream.streamName,  // Kinesis Data Streams streamName
        MIN_CONFIDENCE: '70',                               // Rekognition クマ判定の閾値 (%)
        CAMERA_ID: 'cam-01',                                // カメラID
      },
    });

    // Lambda に Kinesis Video Streams へのアクセス権限を付与
    frameExtractorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'kinesisvideo:GetDataEndpoint',  // エンドポイント取得
        'kinesisvideo:GetImages',        // 画像取得（Archived Media）
      ],
      resources: [videoStream.attrArn],
    }));

    // 一部のAPIはリソース指定できないことがあるので、必要なら resource: '*' にしておくのもアリ
    // frameExtractorFunction.addToRolePolicy(new iam.PolicyStatement({
    //   actions: ['kinesisvideo:GetImages'],
    //   resources: ['*'],
    // }));

    // Rekognition DetectLabels を使用するための権限
    frameExtractorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:DetectLabels'],
      resources: ['*'], // DetectLabels はリソース指定できないので *
    }));

    // 検出結果を Kinesis Data Streams に送信するための権限 (kinesis:PutRecord)
    detectionStream.grantWrite(frameExtractorFunction);

    // 一定間隔で Lambda を実行する EventBridge Rule
    const frameScheduleRule = new events.Rule(this, 'KumaFrameExtractorScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)), // 1 min 間隔で実行（sec は不可のため）
    });
    frameScheduleRule.addTarget(new targets.LambdaFunction(frameExtractorFunction)); // ターゲット指定

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
