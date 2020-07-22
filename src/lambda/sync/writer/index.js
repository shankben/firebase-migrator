const { DocumentClient } = require("aws-sdk/clients/dynamodb");
const ddb = new DocumentClient({ region: process.env.AWS_REGION });

async function ensureMetaPartition() {
  let res;

  const params = {
    TableName: process.env.TABLE_NAME,
    ConsistentRead: true,
    ExpressionAttributeValues: {":meta": "META"},
    KeyConditionExpression: "pk = :meta",
    Limit: 1
  };

  res = await ddb.query(params).promise();

  if (res.Count !== 0) return res.Items[0];

  await ddb.put({
    TableName: process.env.TABLE_NAME,
    Item: {
      pk: "META",
      sk: "META"
    }
  }).promise();

  res = await ddb.query(params).promise();

  return res.Items[0];
}

async function updateFacets(docs) {
  const meta = await ensureMetaPartition();
  const facets = Array.from(new Set(docs.map((it) => it.__facet)
    .concat("facets" in meta ? meta.facets.values : [])));
  if (facets.length > 0) {
    const params = {
      TableName: process.env.TABLE_NAME,
      Key: {
        pk: meta.pk,
        sk: meta.sk
      },
      ExpressionAttributeNames: {
        "#facets": "facets",
        "#facetItemAttributeName": "facetItemAttributeName"
      },
      ExpressionAttributeValues: {
        ":facets": ddb.createSet(facets),
        ":facetItemAttributeName": "__facet"
      },
      UpdateExpression: `SET
        #facets = :facets,
        #facetItemAttributeName = :facetItemAttributeName`
    };
    await ddb.update(params).promise();
  }
}

async function mergeDocs(docs) {
  const existingDocs = await Promise.all(docs.map(async (it) => {
    const params = {
      TableName: process.env.TABLE_NAME,
      IndexName: "firestoreDocumentId-firestoreUpdatedAt-index",
      ExpressionAttributeNames: {"#docId": "__firestoreDocumentId"},
      ExpressionAttributeValues: {":pk": it.__firestoreDocumentId},
      KeyConditionExpression: "#docId = :pk",
      Limit: 1
    };
    const res = await ddb.query(params).promise();
    return res.Count === 0 ? {} : res.Items.shift();
  }));
  const exisitingDocsById = Object.fromEntries(existingDocs
    .map((it) => [it.__firestoreDocumentId, it]));
  return ddb.batchWrite({
    RequestItems: {
      [process.env.TABLE_NAME]: docs.map((it) => {
        const primaryKey = it.__firestoreDocumentId in exisitingDocsById ? {
          pk: exisitingDocsById[it.__firestoreDocumentId].pk,
          sk: exisitingDocsById[it.__firestoreDocumentId].sk
        } : {
          pk: it.pk,
          sk: it.sk
        };
        return {
          PutRequest: {
            Item: {
              ...(exisitingDocsById[it.__firestoreDocumentId] || {}),
              ...it,
              ...primaryKey,
              updatedAt: new Date().toISOString()
            }
          }
        }
      })
    }
  }).promise();
}

exports.handler = async (event) => {
  const docs = event.Records
    .map((it) => JSON.parse(it.body))
    .reduce((x, y) => x.concat(y), []);
  if (docs.length === 0) return {};
  await updateFacets(docs);
  await mergeDocs(docs);
  return {};
};
