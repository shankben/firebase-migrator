import fs from "fs";
import http from "http";
import { spawnSync } from "child_process";

import * as AWS from "aws-sdk";
const ssm = new AWS.SSM();
const cfn = new AWS.CloudFormation();

const getCredentials = (): Promise<{[k: string]: string}> =>
  new Promise((resolve, reject) => {
    const url = "http://169.254.170.2" +
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    let rawData = "";
    http.get(url, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", (err) => reject(err));
  });

const writeFirebaseServiceAccount = async () => {
  const { FIREBASE_PROJECT_ID } = process.env;
  const params = {
    Name: `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseServiceAccount`,
    WithDecryption: true
  };
  const res = await ssm.getParameter(params).promise();
  fs.writeFileSync("FirebaseServiceAccount.json", res.Parameter!.Value!);
};

const getFirebaseAppConfig = async () => {
  const { FIREBASE_PROJECT_ID } = process.env;
  const params = {
    Name: `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseAppConfig`,
    WithDecryption: true
  };
  const res = await ssm.getParameter(params).promise();
  return JSON.parse(res.Parameter!.Value!);
};

const getAwsConfig = async () =>
  JSON.parse(((await cfn.describeStacks({
    StackName: `${process.env.FIREBASE_PROJECT_ID}-ApiStack`
  }).promise()).Stacks ?? [])
    .map((stack) => (stack.Outputs ?? [])
      .find((output) => output.OutputKey! === "AmplifyConfigOutput"))
    .filter((it) => it)!
    .shift()!
    .OutputValue!);

const gcloudAuthenticate = async () => {
  const args = [
    "auth",
    "activate-service-account",
    "--key-file=FirebaseServiceAccount.json"
  ];
  console.log(`Executing ${args.join(" ")}`);
  spawnSync("gcloud", args);
};

const gsutilRsync = (source: string, target: string) => {
  const args= [
    "rsync",
    "-d",
    "-r",
    `gs://${source}/`,
    `s3://${target}/migrated/`
  ];
  console.log(`Executing ${args.join(" ")}`);
  const res = spawnSync("gsutil", args);
  console.log(res.output
    .filter((it) => it)
    .map((it) => it.toString())
    .join("\n")
  );
};

async function main() {
  const credentials = await getCredentials();
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = credentials.Token;
  process.env.AWS_SECURITY_TOKEN = credentials.Token;
  const firebaseConfig = await getFirebaseAppConfig();
  await writeFirebaseServiceAccount();
  const awsConfig = await getAwsConfig();
  await gcloudAuthenticate();
  gsutilRsync(firebaseConfig.storageBucket, awsConfig.Storage.AWSS3.bucket);
}

main().catch(console.error);
