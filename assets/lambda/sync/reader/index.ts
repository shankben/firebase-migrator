import AWS from "aws-sdk";
import firebaseAdmin from "firebase-admin";

AWS.config.update({ region: process.env.AWS_REGION });
const ssm = new AWS.SSM();
const sqs = new AWS.SQS();

const DEFAULT_BATCH_SIZE = 5;

let initialized = false;

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
  initialized = true;
};

const peek = async (QueueUrl: string) => {
  try {
    const params = {
      QueueUrl,
      AttributeNames: ["ApproximateNumberOfMessages"]
    };
    const res = await sqs.getQueueAttributes(params).promise();
    return parseInt(res.Attributes!.ApproximateNumberOfMessages, 10);
  } catch (err) {
    return 0;
  }
};

exports.handler = async (event: any) => {
  if (!initialized) await initialize();

  const firestore = firebaseAdmin.firestore();

  if (!("reader" in event)) {
    event.reader = {};
  }

  let limit = event.reader.limit || DEFAULT_BATCH_SIZE;
  let offset = event.reader.offset || 0;
  let { collection, partitionKey, sortKey } = event.reader;

  const collections = event.reader.collections || event.primer.collections;
  if (!collection && collections.length) {
    collection = collections.pop();
  }

  let docs: Record<string, any>[] = [];
  try {
    console.log(`Syncing documents from ${collection}: [${offset}, ${limit}]`);
    docs = (await firestore
      .collection(collection)
      .limit(limit)
      .offset(offset)
      .get())
      .docs
      .map((it) => {
        const item: Record<string, any> = {
          ...it.data(),
          __firestoreDocumentId: it.id,
          __firestoreUpdatedAt: it.updateTime.toDate().toISOString(),
          __facet: collection
        };

        partitionKey = partitionKey || (`${collection}Id` in item ?
          `${collection}Id` : "__firestoreDocumentId");
        item.pk = item[partitionKey];
        if (partitionKey !== "pk" && partitionKey !== "__firestoreDocumentId") {
          delete item[partitionKey];
        }

        sortKey = sortKey || "__firestoreUpdatedAt";
        item.sk = item[sortKey];
        if (sortKey !== "sk" && sortKey !== "__firestoreUpdatedAt") {
          delete item[sortKey];
        }

        return item;
      });
  } catch (err) {
    // OK
  }

  const remaining = await peek(process.env.WRITE_QUEUE_URL!);
  console.log(`Queued items: ${remaining}`);

  if (docs.length) {
    console.log(`Processing ${docs.length}`);
  } else {
    collection = collections.pop();
    limit = DEFAULT_BATCH_SIZE;
    offset = -DEFAULT_BATCH_SIZE;
    partitionKey = null;
    sortKey = null;
  }

  return {
    docs,
    collections,
    collection,
    continue: remaining !== 0 || collection !== undefined,
    limit,
    offset: offset + limit,
    partitionKey,
    sortKey
  };
};
