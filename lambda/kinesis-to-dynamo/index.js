const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const client = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME; // DynamoDB テーブル名

// Rekognition -> kinesis から送られてきたストリームを Dynamo のテーブルに登録する
exports.handler = async (event) => {
  console.log('Kinesis event:', JSON.stringify(event, null, 2));

  // event の Records を取得
  const records = event.Records ?? [];

  for (const rec of records) {
    try {
      // Kinesis のデータは Base64 エンコードされたバイナリで来るため UTF-8 に変換
      const payload = Buffer.from(rec.kinesis.data, 'base64').toString('utf-8');

      console.log('Raw record payload:', payload);

      // JSON 文字列をパース
      const data = JSON.parse(payload);
      console.log('data:', data);

      /*
      - Kinesis event Records
      "data": "eyJjYW1lcmFJZCI6ImNhbS0wMSIsImRldGVjdGVkQXQiOiIyMDI1LTExLTEzVDEyOjM0OjU2WiIsInNwZWNpZXMiOiJrdW1hIiwiY29uZmlkZW5jZSI6MC45MSwia3VtYUNvdW50IjozfQ==",

      - UTF-8 変換後
      {
          "cameraId": "cam-01",
          "detectedAt": "2025-11-13T12:34:56Z",
          "species": "kuma",
          "confidence": 0.91,
          "kumaCount": 3
      }

      - JSON パース後
      {
        cameraId: 'cam-01',
        detectedAt: '2025-11-13T12:34:56Z',
        species: 'kuma',
        confidence: 0.91,
        kumaCount: 3
      }
      */

      // 必須項目がなければスキップ
      if (!data.cameraId || !data.detectedAt) { // Dynamo の partitionKey or sortKey が存在しない場合スキップ
        console.warn('No cameraId or detectedAt, skipping:', data);
        continue;
      }

      // Dynamo テーブルに登録するレコード
      const item = {
        cameraId:   { S: data.cameraId },              // カメラ ID（S: 文字列）
        detectedAt: { S: data.detectedAt },            // 検出時刻（S: 文字列）
        species:    { S: data.species ?? 'unknown' },  // 種別（S: 文字列）
        confidence: data.confidence != null            // 信頼度
          ? { N: String(data.confidence) }             //（データが存在するとき N: 数値）
          : { NULL: true },                            //（データが存在しないとき Null）
        kumaCount: data.kumaCount != null              // くまカウント
          ? { N: String(data.kumaCount) }              //（データが存在するとき N: 数値）
          : { NULL: true },                            //（データが存在しないとき Null）
      };

      // PutItem 実行
      await client.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: item,
        }),
      );

      console.log('PutItem succeeded:', item);
    } catch (err) {
      console.error('Error processing record:', err);
      // throw せず成功したレコードだけ Dynamo に登録する
    }
  }

  return { statusCode: 200 };
};
