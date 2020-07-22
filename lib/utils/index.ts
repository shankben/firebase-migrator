import fs from "fs";
import path from "path";

import AWS from "aws-sdk";
import SSM from "aws-sdk/clients/ssm";

import { isDateTime } from "./date";
import { setIntersect } from "./set";
import capitalize from "./capitalize";
import {
  PseudoGraphqlSchema,
  hydratePseudoSchema,
  introspectGraphqlSchema
} from "./introspect-schema";

const REGION = process.env.AWS_REGION ??
  process.env.CDK_DEPLOY_REGION ??
  process.env.CDK_DEFAULT_REGION ??
  "us-east-1";

const PROJECT_ROOT_PATH = path.join(__dirname, "..", "..");
const SECRETS_PATH = path.join(PROJECT_ROOT_PATH, "secrets");

AWS.config.update({ region: REGION });
const ssm = new SSM();
const ddb = new AWS.DynamoDB.DocumentClient();

export const getMetaItem = async (tableName: string) => (await ddb
  .query({
    TableName: tableName,
    ExpressionAttributeValues: {":meta": "META"},
    KeyConditionExpression: "pk = :meta",
    Limit: 1
  })
  .promise())
  .Items![0];

export const ensureFirebaseCredentials = () => {
  const check = (fileName: string) => {
    try {
      fs.statSync(path.join(SECRETS_PATH, fileName));
    } catch (err) {
      throw new Error(`Copy ${fileName} to secrets/`);
    }
  };
  check("FirebaseAppConfig.json");
  check("FirebaseServiceAccount.json");
};

export const ensureLambdaBaseLayerDependencies = () => {
  try {
    fs.statSync(path.join(PROJECT_ROOT_PATH, "src", "lambda", "layers",
      "base", "nodejs", "node_modules"));
  } catch (err) {
    throw new Error("Lambda base layer dependencies need to be installed");
  }
};

export const ensureParameters = async () => Promise.all(fs
  .readdirSync(SECRETS_PATH)
  .filter((it) => /\.json$/.test(it))
  .map(async (it) => {
    const name = it.split(/\.json$/).shift()!;
    const parameterName = `/FirebaseMigrator/${getFirebaseProjectId()}/${name}`;
    const res = await ssm.describeParameters().promise();
    return res.Parameters!
      .filter((it) => it.Name === parameterName).length !== 0 ?
        Promise.resolve() :
        ssm.putParameter({
          Name: parameterName,
          Value: fs.readFileSync(path.join(SECRETS_PATH, it)).toString(),
          Type: "SecureString",
          Overwrite: true
        }).promise();
  }));

export const getFirebaseProjectId = () => JSON.parse(fs.readFileSync(path
  .join(SECRETS_PATH, "FirebaseServiceAccount.json"))
  .toString())
  .project_id;

import {
  AnyObject,
  firstKey,
  flatten,
  isObject,
  sortKeys,
  unflatten
} from "./object";

export {
  AnyObject,
  PseudoGraphqlSchema,
  capitalize,
  firstKey,
  flatten,
  hydratePseudoSchema,
  introspectGraphqlSchema,
  isDateTime,
  isObject,
  setIntersect,
  sortKeys,
  unflatten
};
