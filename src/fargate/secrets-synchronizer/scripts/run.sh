#!/bin/bash

set -e

docker run \
  --rm \
  -it \
  -e AWS_REGION=$AWS_REGION \
  -e AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN \
  -e FIREBASE_PROJECT_ID=ionic-conference-demo \
  --name secrets-synchronizer \
  secrets-synchronizer
