const { DocumentClient } = require("aws-sdk/clients/dynamodb");
const {
  introspectGraphqlSchema
} = require("firebase-migrator-utils/introspect-schema");

const ddb = new DocumentClient({ region: process.env.AWS_REGION });

const getMetaItem = async (tableName) => (await ddb
  .query({
    TableName: tableName,
    ExpressionAttributeValues: {":meta": "META"},
    KeyConditionExpression: "pk = :meta",
    Limit: 1
  })
  .promise())
  .Items
  .shift();

exports.handler = async (event) => {
  const metaItem = await getMetaItem(process.env.TABLE_NAME);
  const pseudoSchema = await introspectGraphqlSchema(process.env.TABLE_NAME);

  await ddb.put({
    TableName: process.env.TABLE_NAME,
    Item: {
      ...metaItem,
      pseudoSchema
    }
  }).promise();

  return {};
};




// const execute = async (tableName) => {
//   const metaItem = await getMetaItem(tableName);
//   const pseudoSchema = await introspectGraphqlSchema(tableName);
//
//   const params = {
//     TableName: tableName,
//     Item: {
//       ...metaItem,
//       pseudoSchema
//     }
//   };
//   await ddb.put(params).promise();
//
//   return {
//     PhysicalResourceId: `PseudoSchema${Number(new Date())}`,
//     Data: {
//       tableName,
//       pseudoSchema: JSON.stringify(pseudoSchema)
//     }
//   };
// };
//
// const status = async (data) => {
//   const { tableName, pseudoSchema } = data;
//   const metaItem = await getMetaItem(tableName);
//   return {
//     IsComplete: JSON.stringify(metaItem.pseudoSchema) === pseudoSchema
//   };
// };
//
// exports.onEvent = async (event) => {
//   switch (event.RequestType) {
//     case "Create":
//     case "Update":
//       return await execute(event.ResourceProperties.tableName);
//   }
// };
//
// exports.isComplete = async (event) => {
//   switch (event.RequestType) {
//     case "Create":
//     case "Update":
//       return await status(event.Data);
//     case "Delete":
//       return { IsComplete: true };
//   }
// };
