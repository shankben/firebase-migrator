#!/bin/bash

set -e

CWD=$(pwd -P)

mkdir -p dist/lib/utils

rsync -azr --delete secrets/ dist/secrets/
rsync -azr --delete assets/ dist/assets/
rsync -azr --delete lib/utils/package.json dist/lib/utils/

npx tsc

cd dist/assets/lambda/layers/base/nodejs && \
npm i --no-package-lock $(npm pack $CWD/dist/lib/utils | tail -1) && \
rm *.tgz
