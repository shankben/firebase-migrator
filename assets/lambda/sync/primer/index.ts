import AWS from "aws-sdk";
import firebaseAdmin from "firebase-admin";

AWS.config.update({ region: process.env.AWS_REGION });
const ssm = new AWS.SSM();

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

exports.handler = async () => {
  if (!initialized) await initialize();
  const firestore = firebaseAdmin.firestore();
  const collections = (await firestore.listCollections()).map((it) => it.id);
  return {
    collections
  };
};
