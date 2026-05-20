<!-- omit in toc -->
# Kuma Detection System on AWS

本システムは、監視カメラ映像を AWS 上で解析し、  
AI によるクマ検出、検出フレームの保存、Bounding Box 付き画像の生成、メール通知を行う  
サーバレスなクマ検出システムである  

---

- [デモンストレーション](#デモンストレーション)
- [システム概要](#システム概要)
- [主な機能](#主な機能)
- [システムアーキテクチャ](#システムアーキテクチャ)
- [技術的な工夫ポイント](#技術的な工夫ポイント)
- [今後の改善ポイント](#今後の改善ポイント)


---

# デモンストレーション

## 1. クマ検出・Bounding Box 画像生成機能

Kinesis Video Streams に送信された監視カメラ映像からフレームを抽出し、  
Amazon Rekognition によりクマを検出する  

クマを検出した場合、検出フレームと Bounding Box 付き画像を S3 に保存する  

<p align="center">
  <img src="./docs/img/readme/kuma-detection-bbox-1.jpg" alt="クマ検出BBOX画像1" width="900">
</p>

---

## 2. 検出結果の保存機能

クマ検出時には、検出結果を DynamoDB に保存する  

保存される主な情報は以下となる  

- cameraId
- detectedAt
- species
- confidence
- kumaCount
- s3Key
- s3KeyBbox
- boundingBox

DynamoDB 登録例:  

```json
{
  "cameraId": "cam-01",
  "detectedAt": "2026-05-20T17:37:09.099+09:00",
  "species": "kuma",
  "confidence": 99.95014953613281,
  "kumaCount": 1
}
```

## 3. SNS メール通知機能

DynamoDB に検出結果が登録されると、SNS 経由でメール通知を行う

通知メール例:
```
ʕ•ᴥ•ʔ Kuma san ni deatta!!! ʕ•ᴥ•ʔ

(ᵔᴥᵔ) Kuma detected (ᵔᴥᵔ) on camera: cam-01, at: 2026-05-20T17:37:09.099+09:00
```

## 4. Rekognition の判定ログ

本システムでは、Amazon Rekognition の DetectLabels API を使用して、
抽出した各フレームに含まれるラベルを判定している

クマ検出時には、以下のように Bear ラベルと Bounding Box が返却される
```json
{
  "Name": "Bear",
  "Confidence": 99.95014953613281,
  "Instances": [
    {
      "BoundingBox": {
        "Height": 0.37886834144592285,
        "Left": 0.07720152288675308,
        "Top": 0.5058383941650391,
        "Width": 0.2531565725803375
      },
      "Confidence": 99.95014953613281
    }
  ]
}
```

CloudWatch Logs から、フレーム抽出、Rekognition 判定、S3 保存、Kinesis Data Streams 送信までの流れを確認できる

# システム概要

近年、住宅地や農地周辺における野生動物の出没が問題となっている
特にクマの出没は、人身被害や農作物被害につながる可能性があり、早期検知が重要となる

本システムでは、監視カメラ映像を AWS に取り込み、
AI 画像認識によってクマを検出し、検出結果を保存・通知することで、
野生動物の早期発見や監視業務の効率化を目的としている

# 主な機能

本システムに搭載されている機能は以下となる

1. 監視カメラ映像の取り込み

GStreamer を使用して、動画ファイルまたはカメラ映像を Kinesis Video Streams に送信する

テストでは、クマが映った動画ファイルを KVS に送信し、
実運用に近い監視カメラ映像を想定した検証を行っている

2. フレーム抽出

EventBridge により Lambda を定期実行し、
Kinesis Video Streams の直近映像からフレームを抽出する

取得したフレームは S3 に保存し、Rekognition の判定対象とする

3. AI によるクマ検出

Amazon Rekognition の DetectLabels API を使用して、
抽出したフレームに Bear / Black Bear / Brown Bear などのラベルが含まれるかを判定する

検出スコアが閾値を超えた場合、クマ検出イベントとして後続処理を実行する

4. Bounding Box 付き画像生成

Rekognition が返却した Bounding Box 情報を基に、
検出フレーム上に枠線を描画した画像を生成する

これにより、画像のどの領域をクマとして判定したかを視覚的に確認できる

5. 検出結果の保存・通知

クマを検出した場合、検出結果を Kinesis Data Streams に送信し、
後続 Lambda で DynamoDB に保存する

DynamoDB Streams をトリガーとして SNS メール通知を行う

# システムアーキテクチャ

## 画像解析アーキテクチャ

### Kinesis Video Streams による映像取り込み

本システムでは、監視カメラ映像の取り込み先として Kinesis Video Streams を使用している

KVS を使用することで、以下のようなメリットがある

- 映像データをストリームとして AWS 上に取り込める
- Lambda から直近の映像フレームを取得できる
- 実カメラ映像への拡張がしやすい
- サーバレス構成と組み合わせやすい

⸻

### EventBridge + Lambda による定期フレーム抽出

EventBridge で Lambda を定期実行し、
Kinesis Video Streams の直近一定期間の映像からフレームを取得する

テスト時は多めにフレームを取得し、本番時は取得枚数を抑えることで、
検出精度とコストのバランスを調整できる構成としている

| モード | SamplingInterval | MaxResults | 用途 |
| --- | --- | --- | --- |
| test | 2000ms | 30 | 検証用 |
| prod | 5000ms | 12 | 本番想定 |

### Rekognition によるラベル検出

抽出した各フレームを Amazon Rekognition に渡し、
画像内に含まれるオブジェクトのラベルを検出する

クマ判定では、ラベル名に bear を含むものを抽出している

対象例:

- Bear
- Black Bear
- Brown Bear

# 技術的な工夫ポイント

1. KVS フレーム取得データの Base64 デコード対応

Kinesis Video Streams の GetImages API から取得した ImageContent は、
Rekognition にそのまま渡すと InvalidImageFormatException が発生した

そのため、ImageContent を Base64 文字列として扱い、
JPEG バイナリにデコードしてから Rekognition に渡すようにしている

```javascript
const b64 = Buffer.from(img.ImageContent).toString('utf-8');
const jpegBuf = Buffer.from(b64, 'base64');
```

2. 全フレーム判定による検出率向上

当初は取得したフレームの先頭1枚のみを Rekognition に渡していたため、
クマが映っているタイミングを逃す可能性があった

現在は、取得した全フレームをループ処理し、
各フレームに対して Rekognition 判定を行う構成としている

これにより、短時間だけ映るクマや、小さく映るクマも検出しやすくしている

3. Bounding Box の有無を考慮した処理

Rekognition は Bear ラベルを返しても、
必ずしも Instances や BoundingBox を返すとは限らない

そのため、Bounding Box が存在する場合のみアノテーション画像を生成し、
存在しない場合でも検出結果として DynamoDB に保存するようにしている

```javascript
const firstInstance = (topKuma.Instances || [])[0];
const bbox = firstInstance ? firstInstance.BoundingBox : null;
```

4. Lambda のタイムアウト・メモリ調整

複数フレームを Rekognition に渡し、さらに Bounding Box 付き画像を生成する場合、
Lambda の実行時間とメモリ使用量が大きくなる

検証時には Lambda の timeout と memorySize を大きめに設定し、
複数フレームを安定して処理できるようにしている

本番運用では、1回の実行で処理するフレーム数や通知頻度を調整することで、
コストと性能のバランスを取る想定である

5. サーバレスなイベント駆動構成

本システムは、Kinesis Video Streams、Lambda、Rekognition、S3、DynamoDB、SNS を組み合わせた
サーバレスなイベント駆動アーキテクチャとして構成している

常駐サーバを持たず、映像入力や検出イベントに応じて必要な処理のみ実行されるため、
小規模な監視システムとして運用しやすい構成となっている

| 技術 | 用途 | 
| --- | --- | 
| AWS CDK | インフラ構築 | 
| TypeScript | CDK 実装 | 
| Node.js | Lambda 実装 | 
| Amazon Kinesis Video Streams | 監視カメラ映像の取り込み | 
| Amazon Rekognition | AI 画像認識 / クマ検出 | 
| Amazon S3 | 抽出フレーム / BBOX 画像保存 | 
| Amazon Kinesis Data Streams | 検出イベント連携 | 
| AWS Lambda | フレーム抽出 / DynamoDB 保存 / 通知処理 | 
| Amazon DynamoDB | 検出結果保存 | 
| DynamoDB Streams | 検出イベントの通知トリガー | 
| Amazon SNS | メール通知 | 
| Amazon EventBridge | 定期実行 | 
| GStreamer | 映像ストリーミング | 
| Jimp | Bounding Box 画像生成 | 

# 今後の改善ポイント

現時点でも、KVS に送信した映像からクマを検出し、
検出画像の保存、DynamoDB 登録、SNS 通知まで一連の処理が動作している

より本格的なシステムへ改善するために、以下の方針を検討している

実カメラ映像への対応

現在はテスト用の動画ファイルを KVS に送信して検証している
今後は、実際のネットワークカメラや Raspberry Pi カメラから映像を送信し、
より実運用に近い検証を行う

誤検知・未検知への対策

Rekognition の汎用モデルでは、暗所映像や小さく映るクマの判定にばらつきがある
今後は、以下の方法で検出精度を改善する

- Confidence 閾値の調整
- 複数フレーム連続検出による判定
- Amazon Rekognition Custom Labels の利用
- 学習済み物体検出モデルの導入

通知内容の改善

現在の通知は、検出時刻と cameraId を中心とした簡易通知となっている
今後は、S3 の署名付き URL や BBOX 付き画像へのリンクを通知に含めることで、
通知メールから検出画像をすぐ確認できるようにする

運用モードの切り替え

現在は検証用に多めのフレームを取得している
本番運用では、以下のようにモードを切り替えることでコスト最適化を行う

- test: 多めにフレーム取得し、検出精度や挙動を確認
- prod: フレーム取得間隔を広げ、コストを抑えて運用

監視・可観測性の強化

CloudWatch Metrics / Logs を活用し、以下の情報を可視化する

- Lambda 実行回数
- Rekognition 実行回数
- クマ検出件数
- 通知件数
- エラー件数
- 処理時間

---
