FROM node:lts-alpine
WORKDIR /app
COPY "package.json" ./
RUN \
  apk upgrade && \
  npm i --no-package-lock
COPY "*" ./
ENTRYPOINT ["npx", "ts-node", "index.ts"]
