#!/bin/bash

set -e

mkdir -p dist

rsync -azr --delete secrets/ dist/secrets/
rsync -azr --delete src/ dist/src/
rsync -azr --delete lib/utils/package.json dist/lib/utils/

npx tsc && \
cd dist/src/lambda/sync/introspector && \
npm install --no-package-lock $(npm pack ../../../../lib/utils | tail -1) && \
rm *.tgz
