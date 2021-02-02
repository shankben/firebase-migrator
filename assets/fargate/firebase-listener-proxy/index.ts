import AWS from "aws-sdk";
import * as firebaseAdmin from "firebase-admin";
import {
  QuerySnapshot,
  DocumentChange,
  DocumentData
} from "@google-cloud/firestore";

import { singular as singularize } from "pluralize";
import "isomorphic-fetch";
import AWSAppSyncClient from "aws-appsync";
import { AUTH_TYPE } from "aws-appsync/lib/client";
import gql from "graphql-tag";
import * as mutations from "./graphql/mutations";

AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();
const cfn = new AWS.CloudFormation();

let appSync: any;

const capitalize = (x: string): string => x[0].toUpperCase() + x.substring(1);

const getStackOutput = async (StackName: string, key: string) => JSON.parse(
  ((await cfn.describeStacks({ StackName }).promise()).Stacks ?? [])
    .map((stack) => (stack.Outputs ?? [])
      .find((output) => output.OutputKey === key))
    .filter((it) => it)
    .shift()!
    .OutputValue!);

const getAmplifyConfig = async () => getStackOutput(
  `${process.env.FIREBASE_PROJECT_ID}-ApiStack`,
  "AmplifyConfigOutput"
);

const initialize = async () => {
  const { FIREBASE_PROJECT_ID } = process.env;
  const params = {
    Name: `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseServiceAccount`,
    WithDecryption: true
  };
  const res = await ssm.getParameter(params).promise();
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(JSON.parse(res.Parameter!.Value!))
  });
  const amplifyConfig = await getAmplifyConfig();
  appSync = await new AWSAppSyncClient({
    disableOffline: true,
    url: amplifyConfig.aws_appsync_graphqlEndpoint,
    region: amplifyConfig.aws_appsync_region,
    auth: {
      type: AUTH_TYPE.AWS_IAM,
      credentials: new AWS.ECSCredentials()
    }
  }).hydrated();
};

const triggerUpdateMutation = async (typename: string, docId: string) => {
  const mutationName = `update${typename}`;
  const mutation = (mutations as {[k: string]: string})[mutationName];
  await appSync.mutate({
    mutation: gql(mutation),
    variables: {
      input: {
        key: docId
      }
    }
  });
};

const itemByFirestoreDocumentId = async (docId: string) => {
  const qParams = {
    TableName: process.env.TABLE_NAME!,
    IndexName: "firestoreDocumentId-firestoreUpdatedAt-index",
    ExpressionAttributeNames: {"#docId": "__firestoreDocumentId"},
    ExpressionAttributeValues: {":pk": docId},
    KeyConditionExpression: "#docId = :pk",
    Limit: 1
  };
  const res = await ddb.query(qParams).promise();
  return res.Count === 0 ? {} : res.Items!.shift()!;
};

const onModified = async (
  collection: string,
  it: DocumentChange<DocumentData>
) => {
  try {
    const item = await itemByFirestoreDocumentId(it.doc.id);
    const pParams = {
      TableName: process.env.TABLE_NAME!,
      Item: {
        ...item,
        ...it.doc.data(),
        __firestoreUpdatedAt: it.doc.updateTime.toDate().toISOString()
      }
    };
    await ddb.put(pParams).promise();
    await triggerUpdateMutation(capitalize(singularize(collection)), it.doc.id);
    console.log(`[${it.type}]  ${collection}: ${it.doc.id}`);
  } catch (err) {
    console.error(err);
  }
};

const listenToCollection = async (collection: string) => firebaseAdmin
  .firestore()
  .collection(collection)
  .onSnapshot((snapshot: QuerySnapshot<DocumentData>) => snapshot
    .docChanges()
    .forEach(async (it: DocumentChange<DocumentData>) => {
      switch (it.type) {
        case "modified":
          onModified(collection, it);
          break;
      }
    }),
    (err: Error) => console.error(err)
  );

async function main() {
  console.log("Firebase Listener Proxy");
  process.on("SIGINT", () => process.exit());
  await initialize();
  const firestore = firebaseAdmin.firestore();
  const collections = (await firestore.listCollections()).map((it) => it.id);
  await Promise.all(collections.map(listenToCollection));
}

main().catch(console.error);
