FROM node:lts-alpine
WORKDIR /app
COPY "package.json" ./
RUN \
  apk upgrade && \
  npm i --no-package-lock
COPY "*" ./
RUN npx tsc
ENTRYPOINT ["node", "dist/index.js"]
