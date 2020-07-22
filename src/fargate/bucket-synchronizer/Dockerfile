FROM google/cloud-sdk:slim
WORKDIR /app
COPY "package.json" ./
RUN \
  apt update && \
  apt install -y \
    nodejs \
    npm && \
  npm update -g npm && \
  npm install --no-package-lock
COPY "*" ./
ENTRYPOINT ["npx", "ts-node", "index.ts"]
