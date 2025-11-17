const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoArchivedMediaClient, GetImagesCommand } = require('@aws-sdk/client-kinesis-video-archived-media');

const kvsClient = new KinesisVideoClient({});

const VIDEO_STREAM_ARN = process.env.VIDEO_STREAM_ARN;              // Kinesis Video Streams ARN
const DETECTION_STREAM_NAME = process.env.DETECTION_STREAM_NAME;    // Kinesis Data Streams streamName
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || '70');  // Rekognition クマ判定の閾値 (%)
const CAMERA_ID = process.env.CAMERA_ID || 'cam-unknown';           // カメラID

// ストリーミングされた映像からフレームを抽出し、Rekognition によるクマ検出を行う Lambda
// Kinesis Video Streams -> Lambda (EventBridge トリガー) -> Kinesis Data Streams
exports.handler = async (event) => {
  console.log('Frame extractor invoked. Event:', JSON.stringify(event));

  try {
    // Kinesis Video Streamas のエンドポイントを取得（GET_IMAGES 用）
    // -> ストリームの GET_IMAGES 用エンドポイント URL を取得しに行く
    const kvsEp = await kvsClient.send(
      new GetDataEndpointCommand({
        StreamARN: VIDEO_STREAM_ARN, // Kinesis Video Streams ARN
        APIName: 'GET_IMAGES',       // 画像取得 API
      }),
    );
    console.log('Kinesis Video Streams endpoint:', kvsEp.DataEndpoint);

    // Kinesis Video Streams のエンドポイントに対して GET_IMAGES を実行するためのクライアント
    const kvsArchivedClient = new KinesisVideoArchivedMediaClient({
      endpoint: kvsEp.DataEndpoint,
    });

    // 映像から画像を取得する期間の設定
    const endTime = new Date();                             // 現在時刻
    const startTime = new Date(endTs.getTime() - 5 * 1000); // 現在から N 秒前の時刻 (ms)
    // 画像抽出
    // -> N 秒間 で 1 秒ごとにフレームをサンプリングし、その中から 1 枚を取得する
    const extractedImage = await kvsArchivedClient.send(
      new GetImagesCommand({
        StreamARN: VIDEO_STREAM_ARN,            // Kinesis Video Streams ARN
        ImageSelectorType: 'SERVER_TIMESTAMP',  // Kinesis サーバ側のタイムスタンプ基準
        StartTimestamp: startTime,              // 開始時刻
        EndTimestamp: endTime,                  // 終了時刻
        SamplingInterval: 1,                    // 1秒間隔でサンプリング
        Format: 'JPEG',                         // 画像フォーマット
        MaxResults: 1,                          // 1枚だけ取得
      }),
    );

    // 画像が取得できなかった場合は空配列とし後続処理をスキップ
    const images = extractedImage.Images || [];
    if (images.length === 0) {
      console.log('No images found. Skipping.');
      return { statusCode: 200 };
    }

    const image = images[0];
    console.log('Get image at:', image.Timestamp);


  } catch (err) {
    console.error('Error in frame extractor:', err);
    // throw せずにログだけ出力
    return { statusCode: 500, error: err.message };
  }
};
