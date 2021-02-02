import AWS from "aws-sdk";
import { AppSyncResolverEvent } from "aws-lambda";

AWS.config.update({ region: process.env.AWS_REGION });
const ddb = new AWS.DynamoDB.DocumentClient();

const decapitalize = (str: string) => str[0].toLowerCase() + str.substring(1);

const makeKey = (item: Record<string, any>) => {
  let key = item.pk;
  if (item.sk) key += `|${item.sk}`;
  item.key = key;
  return item;
};

const performList = async (facet: string) => {
  const params = {
    TableName: process.env.TABLE_NAME!,
    IndexName: "facet-sk-index",
    ExpressionAttributeNames: {"#facet": "__facet"},
    ExpressionAttributeValues: {":facet": facet},
    KeyConditionExpression: "#facet = :facet"
  };
  const res = await ddb.query(params).promise();
  return res.Count === 0 ? [] : (res.Items ?? []).map(makeKey);
};

const performGet = async (args: Record<string, any>) => {
  if (!("key" in args)) return {};
  const [pk, sk] = args.key.split("|");
  const ean: Record<string, string> = { "#pk": "pk" };
  const eav: Record<string, string> = { ":pk": pk };
  let kce = "#pk = :pk";
  if (sk) {
    ean["#sk"] = "sk";
    eav[":sk"] = sk;
    kce += " AND #sk = :sk";
  }
  const params = {
    TableName: process.env.TABLE_NAME!,
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
    KeyConditionExpression: kce,
    Limit: 1
  };
  const res = await ddb.query(params).promise();
  return res.Count === 0 ? {} : (res.Items ?? []).map(makeKey).shift();
};

const performUpdate = async (input: Record<string, any>) => {
  if (!("key" in input)) return {};
  const [pk, sk] = input.key.split("|");
  const ean: Record<string, string> = {};
  const eav: Record<string, string> = {};
  const key: Record<string, string> = {"pk": pk};
  if (sk) {
    key["sk"] = sk;
  }
  const inputKey = input.key;
  delete input.key;
  Object.keys(input).forEach((k) => {
    ean[`#${k}`] = k;
    eav[`:${k}`] = input[k];
  });
  const ue = "SET " + Object.keys(input)
    .map((k) => `#${k} = :${k}`)
    .join(",\n");
  if (Object.keys(ean).length === 0) {
    return await performGet({ key: inputKey });
  }
  const params = {
    TableName: process.env.TABLE_NAME!,
    Key: key,
    ExpressionAttributeNames: ean,
    ExpressionAttributeValues: eav,
    UpdateExpression: ue,
    ReturnValues: "ALL_NEW"
  };
  const res = await ddb.update(params).promise();
  return makeKey(res.Attributes!);
};

const handleQuery = async (
  operation: string,
  args: Record<string, any>
) => /^get/.test(operation) ?
  performGet(args) :
  /^list/.test(operation) ?
  performList(decapitalize(operation.replace(/^list/, ""))) :
  Promise.resolve({});

const handleMutation = async (
  operation: string,
  args: Record<string, any>
) => /^update/.test(operation) ?
  performUpdate(args) :
  Promise.resolve({});

exports.handler = async (event: AppSyncResolverEvent<Record<string, any>>) => {
  console.log(JSON.stringify(event, null, 2));

  const {
    arguments: args,
    info: {
      parentTypeName,
      fieldName: operation
    }
  } = event;

  switch (parentTypeName) {
    case "Query": return handleQuery(operation, args);
    case "Mutation": return handleMutation(operation, args.input);
    default: return;
  }
};
