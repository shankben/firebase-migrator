FROM node:lts-alpine
WORKDIR /app
COPY "package.json" ./
RUN \
  apk upgrade && \
  npm i -g @aws-amplify/cli && \
  npm i --no-package-lock && \
  amplify configure --usage-data-off
COPY "*" ./
RUN \
  amplify codegen
ENTRYPOINT ["npx", "ts-node", "index.ts"]
