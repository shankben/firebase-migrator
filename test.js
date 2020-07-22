"use strict";

const crypto = require("crypto");
const AWS = require("aws-sdk");

const admin = require("firebase-admin");
const serviceAccount = require("./quickstart-1558482992607-firebase-adminsdk-2vnx2-61b34b6172.json");

const ddbDataModel = require("./Bookmarks-Data-Model.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://quickstart-1558482992607.firebaseio.com"
});

const db = admin.firestore();

db.collection("customers").onSnapshot((querySnapshot) => {
  querySnapshot.docChanges().forEach((change) => {
    switch (change.type) {
      case "added":
      case "modified":
      case "removed":
        console.log(change);
        break;
      default:
        break;
    }
  });
});

async function main() {
  await Promise.all(ddbDataModel.DataModel.shift().TableFacets
    .map(async (facet) => facet.TableData
      .map((it) => AWS.DynamoDB.Converter.unmarshall(it))
      .map((it) => {
        if ("title" in it) {
          it.title = it.title + "-" + (Math.random().toString().substring(3, 6));
        }
        console.log(it);
        return it;
      })
      .map((it) => db.collection(facet.FacetName.toLowerCase())
        .doc(crypto.createHash("sha256")
          .update(`${it.customerId}|${it.sk}`)
          .digest("hex")
          .substring(0, 12))
        .set(it)))
    .reduce((x, y) => x.concat(y), []));

  const snapshot = await db.collection("customers").get();
  snapshot.forEach((doc) => console.log(doc.id, doc.data()));

  // process.exit(0);
}

main().catch(console.error);
