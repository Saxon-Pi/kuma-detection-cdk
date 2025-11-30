const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoArchivedMediaClient, GetImagesCommand } = require('@aws-sdk/client-kinesis-video-archived-media');
const { RekognitionClient, DetectLabelsCommand } = require('@aws-sdk/client-rekognition');
const { KinesisClient, PutRecordCommand } = require('@aws-sdk/client-kinesis');

const kvsClient = new KinesisVideoClient({}); // Kinesis Video Streams クライアント
const rekClient = new RekognitionClient({});  // Rekognition クライアント
const kdsClient = new KinesisClient({});      // Kinesis Data Streams クライアント

const VIDEO_STREAM_ARN = process.env.VIDEO_STREAM_ARN;              // Kinesis Video Streams ARN
const DETECTION_STREAM_NAME = process.env.DETECTION_STREAM_NAME;    // Kinesis Data Streams streamName
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || '70');  // Rekognition クマ判定の閾値 (%)
const CAMERA_ID = process.env.CAMERA_ID || 'cam-unknown';           // カメラID

// ストリーミングされた映像からフレームを抽出し、Rekognition によるクマ検出を行う Lambda
// Kinesis Video Streams -> Lambda (EventBridge トリガー) -> Kinesis Data Streams（クマを検出した場合）
exports.handler = async (event) => {
  console.log('Frame extractor invoked. Event:', JSON.stringify(event));

  try {
    // ########## Kinesis Video Streams の映像からフレームを抽出する ##########

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
    const endTime = new Date();                              // 現在時刻
    const startTime = new Date(endTime.getTime() - 60 * 1000); // 現在から 60s 前の時刻 (ms)
    // 画像抽出
    // -> 60 秒間 に 5 秒ごとにフレームをサンプリング -> 12 枚のフレームを取得する
    const extractedImage = await kvsArchivedClient.send(
      new GetImagesCommand({
        StreamARN: VIDEO_STREAM_ARN,            // Kinesis Video Streams ARN
        ImageSelectorType: 'SERVER_TIMESTAMP',  // Kinesis サーバ側のタイムスタンプ基準
        StartTimestamp: startTime,              // 開始時刻
        EndTimestamp: endTime,                  // 終了時刻
        SamplingInterval: 5000,                 // 5秒間隔でサンプリング (ms)
        Format: 'JPEG',                         // 画像フォーマット
        MaxResults: 12,                         // 12枚だけ取得
      }),
    );

    // extractedImage.Images = undefined / null なら 空配列 [] とする
    // 配列として入ってくるならそのまま
    const images = (extractedImage.Images || [])
    // 配列の中身の img.ImageContent が存在している かつ バイト列がある 中身のある画像だけを残す
    // -> ImageContent が undefined / null / 空バイト列 なら捨てる
      .filter(img => img.ImageContent && img.ImageContent.length > 0);

    // 空配列なら後続処理をスキップ
    if (images.length === 0) {
      console.log('No images found. Skipping.');
      return { statusCode: 200 };
    }

    const image = images[0];
    console.log('Get image at:', image.Timestamp);

    /*
    ### KVS (GetImages) -> Rekognition で InvalidImageFormatException が発生した時の対策メモ ###
    Image first bytes: /9j/4AAQSkZJRgAB... 
    -> JPEG の Base64 エンコード文字列の先頭
    KVS のGetImages が返してきた ImageContent は「JPEG 生バイト」ではなく Base64 文字列をバイト列にしたもの（＝ASCII の /9j/4AAQ...）
	  それをそのまま Image: { Bytes: imageBytes } として Rekognition に渡すことで InvalidImageFormatException が発生している

    TODO:
    ① ImageContent を UTF-8 文字列として取り出す
    ② その文字列を base64 デコードして、本物の JPEG バイナリにする
    ③ その JPEG バイナリを Rekognition に渡す
    */

    // KVS から取得した全てのフレームを Rekognition に判定させる
    for (const img of images) {
      // ① Uint8Array -> 文字列（Base64 テキスト）に変換
      const b64 = Buffer.from(img.ImageContent).toString('utf-8');
      console.log('Image base64 head:', b64.slice(0, 32));

      // ② Base64 テキスト → 本物の JPEG バイト列に変換
      const jpegBuf = Buffer.from(b64, 'base64');
      console.log('JPEG length:', jpegBuf.length);
      console.log('JPEG header bytes:', Array.from(jpegBuf.subarray(0, 4)));
      // -> ここが [255, 216, 255, ...] のようになれば JPEG になっている

      // GetImages から返ってきた ImageContent が jpeg でなければ終了（InvalidImageFormat エラー対策）
      // JPEG のマジックナンバーチェック（0xFF 0xD8）
      if (jpegBuf.length < 4 || jpegBuf[0] !== 0xff || jpegBuf[1] !== 0xd8) {
        console.warn('Decoded data is not JPEG. Skipping this image.');
        continue; // JPEG でなければ、次のフレームへ
      }

      // ③ Rekognition に渡すのはデコード済みの JPEG バイト列とする
      const imageBytes = jpegBuf;

      // ########## Rekognition でフレームからクマさん ʕ•ᴥ•ʔ を検出する ##########

      // Rekognition によるクマ検出
      const kumaDetectResult = await rekClient.send(
        new DetectLabelsCommand({
          Image: { Bytes: imageBytes },
          MaxLabels: 10,                 // 最大で何個までラベルを返すかの上限
          MinConfidence: MIN_CONFIDENCE, // スコア未満のラベルは除外
        }),
      );

      console.log('Rekognition DetectLabels:', JSON.stringify(kumaDetectResult, null, 2));

      // 検出できなかった場合は空配列とする
      const labels = kumaDetectResult.Labels || [];
      // ラベル配列から 'Bear' を含むものを取り出す
      // -> 大文字小文字に関係なく 'bear' を含んでたら抽出する（Name が null / undefined なら空文字として扱う）
      // 'Bear', 'Brown Bear' などクマラベルが複数存在する可能性も考慮
      const kumaLabels = labels.filter((label) =>
        (label.Name || '').toLowerCase().includes('bear'), 
      );
      console.log('kumaLabels:', JSON.stringify(kumaLabels, null, 2));

      // labels 配列イメージ
      /*
      {
        "Labels": [
          {
            "Name": "Bear",
            "Confidence": 97.1,
            "Instances": [ <Bounding boxes> ],
            "Parents": [
              { "Name": "Animal" },
              { "Name": "Mammal" }
            ]
          },
          {
            "Name": "Animal",
            "Confidence": 99.0,
            "Instances": [],
            "Parents": []
          }
        ]
      }
      */

      // このフレームでクマが検出されなければ、次のフレームに遷移
      if (kumaLabels.length === 0) {
        continue;
      }

      // 一番スコアの高いクマさんラベルを使う
      // -> Confidence の降順ソートをした後にインデックス [0] の先頭要素を取得する（Confidence 最大のラベルを抽出）
      const topKuma = kumaLabels.sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))[0];
      // * 配列の連続した二つの要素 (a, b) を減算 (b - a) して、正の値なら b を a の前に配置して、負の値ならそのままにする *
      
      // 検出時間（ISO 8601 形式の文字列に変換: 2025-11-18T13:45:30.123Z）
      const detectedAtIso = new Date().toISOString();

      // ########## クマ検出結果を Kinesis Data Streams に送信する ##########

      // Kinesis Data Streams に送信するペイロードの作成
      // -> クマラベルの、Confidence（スコア）が一番高い要素をベースにペイロードを構成している
      const payload = {
        cameraId: CAMERA_ID,                  // カメラ ID
        detectedAt: detectedAtIso,            // 検出時刻
        species: 'kuma',                      // (ᵔᴥᵔ)
        confidence: topKuma.Confidence || 0,  // クマスコア
        kumaCount: 1,                         // クマカウント（とりあえず 1 固定）
        rawLabelName: topKuma.Name,           // ラベルの Name
      };

      // ペイロードの送信
      await kdsClient.send(
        new PutRecordCommand({
          StreamName: DETECTION_STREAM_NAME,
          PartitionKey: CAMERA_ID,
          Data: Buffer.from(JSON.stringify(payload)),
        }),
      );

      console.log('ʕ•ᴥ•ʔ Kuma-san ni deatta!!! (ᵔᴥᵔ), payload =', payload);
      console.log('PutRecord to KinesisDataStreams succeeded.');

      // 他フレームも判定するならコメントアウト（1回検知できれば OK なら終了する）
      //return { statusCode: 200 };
    }

    // 全フレームでクマさんを検出できなかった場合
    console.log('Checked all frames, no kuma-san. Anshin!');
    return { statusCode: 200 };

  } catch (err) {
    console.error('Error in frame extractor:', err);
    // throw せずにログだけ出力
    return { statusCode: 500, error: err.message };
  }
};
