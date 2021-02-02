import AWS from "aws-sdk";
AWS.config.update({ region: process.env.AWS_REGION });
const ssm = new AWS.SSM();

import firebaseAdmin from "firebase-admin";
import firebase from "firebase/app";
import "firebase/auth";

let initialized = false;

const initialize = async () => {
  const { FIREBASE_PROJECT_ID } = process.env;
  const params = {
    Names: [
      `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseAppConfig`,
      `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseServiceAccount`
    ],
    WithDecryption: true
  };
  const res = await ssm.getParameters(params).promise();
  const {
    FirebaseAppConfig,
    FirebaseServiceAccount
  } = Object.fromEntries(res.Parameters!.map((it) => [
    it.Name!.split("/").pop(),
    JSON.parse(it.Value!)
  ]));
  firebase.initializeApp(FirebaseAppConfig);
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(FirebaseServiceAccount)
  });
  initialized = true;
};

exports.handler = async (event: any) => {
  console.log(JSON.stringify(event, null, 2));

  if (!initialized) await initialize();

  const { triggerSource } = event;
  if (triggerSource !== "UserMigration_Authentication" &&
      triggerSource !== "UserMigration_ForgotPassword") {
    throw new Error(`Bad event trigger ${triggerSource}`);
  }

  const { userName: email } = event;
  const { password } = event.request;
  const username = email.split("@").shift();

  let user;
  switch (triggerSource) {
    case "UserMigration_Authentication":
      user = await firebase.auth().signInWithEmailAndPassword(email, password);
      if (!user) {
        throw new Error(`${email} failed to authenticate with Firebase`);
      }
      event.response = {
        ...event.response,
        finalUserStatus: "CONFIRMED",
        messageAction: "SUPPRESS",
        userAttributes: {
          username,
          email,
          email_verified: "true",
          "custom:firebaseUserId": user.user!.uid
        }
      };
      return event;

    case "UserMigration_ForgotPassword":
      user = await firebaseAdmin.auth().getUserByEmail(email);
      if (!user) {
        throw new Error(`${email} not found in Firebase`);
      }
      event.response = {
        ...event.response,
        messageAction: "SUPPRESS",
        userAttributes: {
          username,
          email,
          email_verified: "true",
          "custom:firebaseUserId": user.uid
        },
      };
      return event;
  }
};
