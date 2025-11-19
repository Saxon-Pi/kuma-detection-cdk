# Rekognition を使用したクマ検出システム構想

## PoC構想  
```mermaid
flowchart LR
    cam[Webカメラ]
    kvs[Kinesis Video Streams]
    rv[Rekognition Video]
    kds[Kinesis Data Streams]
    l1[Lambda①<br/>検知イベント整形]
    ddb[(DynamoDB)]
    l2[Lambda②<br/>DynamoDB Streamsトリガー]
    sns[(SNS)]

    cam --> kvs --> rv --> kds --> l1 --> ddb
    ddb -->|DynamoDB Streams| l2 --> sns
```

## Rekognition vido vs Rekognition image
> Amazon Rekognition Video は、Amazon Kinesis Video Streams を使用して、ビデオストリームを受信し処理します。
> ストリームプロセッサを作成するときに、ストリームプロセッサで検出する内容を選択します。
> 人、パッケージ、ペット、または人とパッケージを選択できます。  

[ストリーミングビデオイベント内のラベルの検出](https://docs.aws.amazon.com/ja_jp/rekognition/latest/dg/streaming-video-detect-labels.html)

Rekognition video でクマさんを検出するのは厳しそう…  
👉 動画で検出することは諦めて、Rekognition Image を使用した静止画での検出とする  
精度に不安はあるが `Bear` タグは存在するため検出は可能  
![Rekognition Image 検出テスト](./images/rekognition-kuma-test.png)

クマ検出までの構成は、以下のパターンが考えられる
1. cam（動画） -> Kinesis Video Streams -> Lambda（フレーム抽出 & 送信） -> Rekognition Image -> ...  
2. cam（静止画を一定間隔で送信） -> API Gateway -> Lambda（バイナリ変換 & 送信） -> Rekognition Image -> ...  

👉 方針として、なるべくAWS内部で処理を集約したい事、リアルタイム寄りのシステムを作りたいため、#1 の KVS を使用するパターンを採用する

## テスト方法
いきなりカメラに接続してクマを撮影するのはハードルが高いため、動画ファイルの映像を Kinesis Video Streams にリアルタイムっぽくストリーミングしてテストを行いたい…！

映像の入力ができれば、以下の一連動作をチェックできる
	•	Kinesis Video Streams → Lambda（フレーム抽出 ＋ Rekognition 検出）
	•	→ Kinesis Data Streams
	•	→ Lambda（kinesis-to-dynamo）
	•	→ DynamoDB
	•	→ Lambda（kuma-notifier）
	•	→ SNSメール通知

今回は Producer SDK（GStreamerプラグイン kvssink）を使う方法を採用する   
公式: http://gstreamer.freedesktop.org/

### GStreamer セットアップの流れ
1. ビルドツールをインストール
```
brew install cmake pkg-config
```
2. GStreamer の本体とプラグインをインストール
```
brew install \
  gstreamer \
  gst-plugins-base \
  gst-plugins-good \
  gst-plugins-bad \
  gst-libav
```
3. OpenSSLをインストール
```
brew install openssl
```
4.	Kinesis Video Streams Producer SDK（C++版）を導入
https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp
ホームディレクトリ直下など、任意の場所で clone
```
cd ~
git clone https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git
cd amazon-kinesis-video-streams-producer-sdk-cpp
```
5. ビルド用ディレクトリを作る
ソースとビルド成果物を分けるタイプのプロジェクトなのでディレクトリを作成する
```
mkdir build
cd build
# dir: /Users/<UserName>/amazon-kinesis-video-streams-producer-sdk-cpp/build
```
`一旦ここまで`   
6.  cmake 実行（GStreamer有効＋OpenSSL場所指定）
mac だと OpenSSL の場所は /opt/homebrew/opt/openssl（ARM）か /usr/local/opt/openssl（Intel）あたりになる
以下のコマンドで確認する
```
brew --prefix openssl
# 例: /opt/homebrew/opt/openssl
```
```
OPENSSL_ROOT=$(brew --prefix openssl)

cmake .. \
  -DBUILD_GSTREAMER_PLUGIN=ON \
  -DOPENSSL_ROOT_DIR=$OPENSSL_ROOT
```
ポイント：
	•	-DBUILD_GSTREAMER_PLUGIN=ON
👉 これで GStreamer プラグイン kvssink をビルド対象にする
	•	-DOPENSSL_ROOT_DIR=...
👉 OpenSSL の場所を教えてあげないと「見つからん！」って怒られることがある

cmake がうまくいくと、最後に

> – Build files have been written to: /Users/…/amazon-kinesis-video-streams-producer-sdk-cpp/build

みたいなメッセージが出るはず

5. makeでビルド
```
make
```
