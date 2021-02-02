import dynamodb from "aws-sdk/clients/dynamodb";

//@ts-ignore
import { getMetaItem, introspectGraphqlSchema } from "firebase-migrator-utils";

const ddb = new dynamodb.DocumentClient({ region: process.env.AWS_REGION });

exports.handler = async (event: any) => {
  const metaItem = await getMetaItem(process.env.TABLE_NAME!);
  const pseudoSchema = await introspectGraphqlSchema(process.env.TABLE_NAME!);
  await ddb.put({
    TableName: process.env.TABLE_NAME!,
    Item: {
      ...metaItem,
      pseudoSchema
    }
  }).promise();
};
