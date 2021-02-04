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
RUN npx tsc
ENTRYPOINT ["node", "dist/index.js"]
