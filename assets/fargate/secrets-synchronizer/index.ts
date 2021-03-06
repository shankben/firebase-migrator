import fs from "fs";
import { Resource } from "@google-cloud/resource";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.AWS_REGION! });
const secretManager = new SecretManagerServiceClient();

const writeFirebaseServiceAccount = async () => {
  const { FIREBASE_PROJECT_ID } = process.env;
  const params = {
    Name: `/FirebaseMigrator/${FIREBASE_PROJECT_ID}/FirebaseServiceAccount`,
    WithDecryption: true
  };
  const res = await ssm.send(new GetParameterCommand(params));
  fs.writeFileSync("FirebaseServiceAccount.json", res.Parameter!.Value!);
};

async function main() {
  const { FIREBASE_PROJECT_ID } = process.env;
  await writeFirebaseServiceAccount();
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "FirebaseServiceAccount.json";
  const resourceClient = new Resource();
  const [projects] = await resourceClient.getProjects();
  const projectNumber = projects
    .find((it) => it.id === FIREBASE_PROJECT_ID)!
    .metadata
    .projectNumber;
  const [secrets] = await secretManager.listSecrets({
    parent: `projects/${projectNumber}`
  });
  await Promise.all(secrets.map(async (secret) => {
    const [accessResponse] = await secretManager.accessSecretVersion({
      name: `${secret.name}/versions/latest`
    });
    const parameterName = [
      "/FirebaseMigrator",
      FIREBASE_PROJECT_ID,
      secret.name!
    ].join("/");
    const params = {
      Name: parameterName,
      Value: accessResponse!.payload!.data!.toString(),
      Overwrite: true,
      Type: "SecureString"
    };
    console.log(`Writing ${parameterName} to SSM`);
    return ssm.send(new PutParameterCommand(params));
  }));
}

main().catch(console.error);
