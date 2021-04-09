import { App } from "@aws-cdk/core";

import ApiStack from "../lib/stacks/api-stack";
import BaseStack from "../lib/stacks/base-stack";
import FirestoreSyncStack from "../lib/stacks/firestore-sync-stack";
import FirestoreListenerStack from "../lib/stacks/firestore-listener-stack";

import {
  ensureFirebaseCredentials,
  ensureLambdaBaseLayerDependencies,
  ensureParameters,
  getFirebaseProjectId
} from "../lib/utils";

async function main() {
  ensureFirebaseCredentials();
  ensureLambdaBaseLayerDependencies();
  await ensureParameters();

  const app = new App();
  const firebaseProjectId = getFirebaseProjectId();
  const id = firebaseProjectId;

  const props = {
    firebaseProjectId,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.AWS_REGION ??
        process.env.CDK_DEPLOY_REGION ??
        process.env.CDK_DEFAULT_REGION ??
        "us-east-1"
    }
  };

  //// Phase 1
  const baseStack = new BaseStack(app, `${id}-BaseStack`, props);

  new FirestoreSyncStack(app, `${id}-SyncStack`, {
    ...props,
    table: baseStack.table
  });

  //// Phase 2
  const apiStack = new ApiStack(app, `${id}-ApiStack`, {
    ...props,
    bucket: baseStack.bucket,
    userAuth: baseStack.userAuth,
    table: baseStack.table
  });

  new FirestoreListenerStack(app, `${firebaseProjectId}-ListenerStack`, {
    ...props,
    api: apiStack.api,
    bucket: baseStack.bucket,
    firebaseProjectId: props.firebaseProjectId,
    table: baseStack.table
  });
}

main().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
