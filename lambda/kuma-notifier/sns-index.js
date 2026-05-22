const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME; // DynamoDB テーブル名
const TOPIC_ARN = process.env.TOPIC_ARN;   // SNS トピックARN

// DynamoDB Streams をイベントに SNSトピックによるメール通知を送信する
exports.handler = async (event) => {
  console.log('DynamoDB Stream event:', JSON.stringify(event, null, 2));

  // event の Records を取得
  const records = event.Records ?? [];

  // Dynamo の eventName: INSERT のときだけ rocords の内容を取り出す（REMOVE などは空配列になる）
  const newItems = records.filter(r => r.eventName === 'INSERT');
  console.log('newItems:', newItems);

  // NewImage が複数存在する（複数の INSERT レコードを渡された）ときのループ処理
  for (const rec of newItems) {
    const newImage = rec.dynamodb.NewImage; // NewImage に cameraId, detectedAt などの要素が入っている

    // todo: score や species などで通知要否をフィルタリングする処理を入れるのもアリ
    // const species = newImage.species?.S;

    // 通知用メッセージ
    const message = `(ᵔᴥᵔ) Kuma detected (ᵔᴥᵔ) on camera: ${newImage.cameraId?.S}, at: ${newImage.detectedAt?.S}`;

    // SNS通知の送信
    await sns.send(new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: 'ʕ•ᴥ•ʔ Kuma san ni deatta!!! ʕ•ᴥ•ʔ',
      Message: message,
    }));
  }

  return { statusCode: 200 };
};
