const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ses = new SESClient({});
const s3 = new S3Client({});

const MAIL_FROM = process.env.MAIL_FROM;
const MAIL_TO = process.env.MAIL_TO;
const PRESIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.PRESIGNED_URL_EXPIRES_SECONDS || '86400',
);

function getStringValue(attribute) {
  return attribute?.S || '';
}

function getNumberValue(attribute) {
  return attribute?.N ? Number(attribute.N) : null;
}

function formatConfidence(confidence) {
  if (confidence === null || confidence === undefined) return '-';
  return `${confidence.toFixed(2)}%`;
}

// 検出日時を JST に変換
function formatDetectedAtJst(detectedAt) {
  if (!detectedAt) return '-';

  const date = new Date(detectedAt);
  if (Number.isNaN(date.getTime())) return detectedAt;

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '/') + ' JST';
}

// BBox 情報を取得
function getBoundingBox(image) {
  const bbox = image.boundingBox?.M;
  if (!bbox) return null;

  return {
    Height: bbox.Height?.N ? Number(bbox.Height.N) : null,
    Left: bbox.Left?.N ? Number(bbox.Left.N) : null,
    Top: bbox.Top?.N ? Number(bbox.Top.N) : null,
    Width: bbox.Width?.N ? Number(bbox.Width.N) : null,
  };
}

// BBox 情報を整形
function formatBBox(bbox) {
  if (!bbox) return 'なし';

  return `あり (Height: ${bbox.Height?.toFixed(4)}, Left: ${bbox.Left?.toFixed(4)}, Top: ${bbox.Top?.toFixed(4)}, Width: ${bbox.Width?.toFixed(4)})`;
}

// SES で送信するメールフォーマット
function buildHtmlBody({
  cameraId,
  detectedAt,
  label,
  confidence,
  kumaCount,
  bbox,
  imageUrl,
  s3Key,
}) {
  const confidenceText = formatConfidence(confidence);
  const detectedAtText = formatDetectedAtJst(detectedAt);
  const bboxText = formatBBox(bbox);

  return `
  <div style="font-family: Arial, sans-serif; background-color: #f6f8fa; padding: 24px;">
    <div style="max-width: 980px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
      
      <div style="background-color: #1f2937; color: #ffffff; padding: 22px 26px;">
        <h1 style="margin: 0; font-size: 24px;">Kuma Detection Alert</h1>
        <p style="margin: 8px 0 0; color: #d1d5db;">監視カメラ映像からクマを検出しました</p>
      </div>

      <div style="padding: 24px;">
        <div style="background-color: #fff7ed; border-left: 5px solid #f97316; padding: 14px 16px; margin-bottom: 24px;">
          <strong>検出結果:</strong> ${label} を ${confidenceText} の信頼度で検出しました。
        </div>

        <h2 style="font-size: 18px; margin: 0 0 14px;">Detection Report</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="width: 64%; vertical-align: top; padding-right: 18px;">
              ${
                imageUrl
                  ? `<img src="${imageUrl}" alt="Kuma Detection Image" style="width: 100%; max-width: 640px; border: 1px solid #d1d5db; border-radius: 8px;" />`
                  : `<p style="font-size:14px;">Bounding Box付き画像はありません。</p>`
              }
            </td>

            <td style="width: 36%; vertical-align: top;">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <th style="text-align:left; padding:10px; background:#f3f4f6; border:1px solid #e5e7eb;">項目</th>
                  <th style="text-align:left; padding:10px; background:#f3f4f6; border:1px solid #e5e7eb;">値</th>
                </tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Camera ID</td><td style="padding:10px; border:1px solid #e5e7eb;">${cameraId}</td></tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Detected At</td><td style="padding:10px; border:1px solid #e5e7eb;">${detectedAtText}</td></tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Label</td><td style="padding:10px; border:1px solid #e5e7eb;">${label}</td></tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Confidence</td><td style="padding:10px; border:1px solid #e5e7eb;">${confidenceText}</td></tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Kuma Count</td><td style="padding:10px; border:1px solid #e5e7eb;">${kumaCount}</td></tr>
                <tr><td style="padding:10px; border:1px solid #e5e7eb;">Bounding Box</td><td style="padding:10px; border:1px solid #e5e7eb;">${bboxText}</td></tr>
              </table>
            </td>
          </tr>
        </table>

        <h2 style="font-size: 18px; margin: 28px 0 12px;">保存先</h2>
        <p style="font-size: 13px; background:#f9fafb; padding:12px; border-radius:8px; word-break:break-all;">
          ${s3Key || '-'}
        </p>

        <p style="font-size: 12px; color: #6b7280; margin-top: 28px;">
          This alert was generated by AWS serverless architecture: Kinesis Video Streams → Lambda → Amazon Rekognition → S3 → DynamoDB → SES.
        </p>
      </div>
    </div>
  </div>
  `;
}

exports.handler = async (event) => {
  console.log('Notifier invoked:', JSON.stringify(event));

  for (const record of event.Records || []) {
    if (record.eventName !== 'INSERT') {
      continue;
    }

    const image = record.dynamodb?.NewImage;
    if (!image) {
      continue;
    }

    const cameraId = getStringValue(image.cameraId);
    const detectedAt = getStringValue(image.detectedAt);
    const label = getStringValue(image.rawLabelName) || 'Bear';
    const confidence = getNumberValue(image.confidence);
    const kumaCount = getNumberValue(image.kumaCount) || 1;

    const s3Bucket = getStringValue(image.s3Bucket);
    const s3Key = getStringValue(image.s3Key);
    const s3KeyBbox = getStringValue(image.s3KeyBbox);

    const bbox = getBoundingBox(image);

    let imageUrl = null;
    if (s3Bucket && s3KeyBbox) {
      imageUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: s3Bucket,
          Key: s3KeyBbox,
        }),
        { expiresIn: PRESIGNED_URL_EXPIRES_SECONDS },
      );
    }

    const htmlBody = buildHtmlBody({
      cameraId,
      detectedAt,
      label,
      confidence,
      kumaCount,
      bbox,
      imageUrl,
      s3Key: s3KeyBbox || s3Key,
    });

    const textBody = [
      'Kuma Detection Alert',
      '',
      `Camera ID: ${cameraId}`,
      `Detected At: ${detectedAt}`,
      `Label: ${label}`,
      `Confidence: ${formatConfidence(confidence)}`,
      `Kuma Count: ${kumaCount}`,
      `S3 Key: ${s3KeyBbox || s3Key || '-'}`,
    ].join('\n');

    const detectedAtText = formatDetectedAtJst(detectedAt);

    const subject = `【クマ検出】${cameraId} / ${detectedAtText} ʕ•ᴥ•ʔ`;

    await ses.send(
      new SendEmailCommand({
        Source: MAIL_FROM,
        Destination: {
          ToAddresses: [MAIL_TO],
        },
        Message: {
          Subject: {
            Data: subject,
            Charset: 'UTF-8',
          },
          Body: {
            Text: {
              Data: textBody,
              Charset: 'UTF-8',
            },
            Html: {
              Data: htmlBody,
              Charset: 'UTF-8',
            },
          },
        },
      }),
    );

    console.log('SES mail sent:', {
      cameraId,
      detectedAt,
      confidence,
      s3Key,
      s3KeyBbox,
    });
  }

  return { statusCode: 200 };
};
