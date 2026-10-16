#!/bin/sh
set -eu
# Keys are provided by the operator; never print them or enable shell tracing.
mc alias set private http://streaming-storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "private/$STREAMING_S3_BUCKET" >/dev/null
mc anonymous set none "private/$STREAMING_S3_BUCKET" >/dev/null
cat >/tmp/policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$STREAMING_S3_BUCKET/streaming/*"]}]}
EOF
mc admin policy create private streaming-api /tmp/policy.json >/dev/null
mc admin user add private "$STREAMING_S3_ACCESS_KEY" "$STREAMING_S3_SECRET_KEY" >/dev/null
mc admin policy attach private streaming-api --user "$STREAMING_S3_ACCESS_KEY" >/dev/null
