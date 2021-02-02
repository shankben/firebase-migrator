# Migration Constructs | Firebase

This CDK application consists of two stacks: a base stack and a dependent API stack. Together, they form an Amplify compatible backend consisting of an AppSync GraphQL API, Cognito User and Identity Pools, and S3 bucket, that mirror existing Firebase Cloud Firestore, Authentication, and Storage resources.

The base stack automatically migrates Firestore data during deploy time by way of a Step Functions machine that reads and iterates through all the collections and documents within, storing them in DynamoDB with a single-table schema. This is an initial implementation design decision. Any target schema or database can be utilized as the write operations in the Step Functions machine are decoupled from the target database.

During deployment of the API stack, a GraphQL schema for use in AppSync is generated using CDK's code-first approach from the single-table DynamoDB schema. This schema can be retrieved in SDL format from AppSync directly to be consumed by Amplify CLI's `codegen` capability.

The infrastructure semi-automatically migrates Firebase Authentication users to a Cognito User Pool by way of a Lambda Migration trigger.

Finally, a Firestore listener service is deployed via Fargate to propagate real time document snapshot events to DynamoDB and trigger AppSync no-op mutations from the server side to push updates to connected clients. A scheduled Fargate task is also provisioned that encapsulates the Google Cloud SDK to perform a `gsutil rsync` from Google Cloud Storage to S3.

It is intended that the Fargate and Step Functions synchronization machinery can be destroyed once Firebase is fully deprecated.

![Architecture Diagram](/firebase-migrator.svg)

## Setup

This CDK application depends on both the Firebase Admin SDK and Firebase SDK, so you'll need to first download Firebase service account credentials and place the JSON file into the `secrets/` directory. Be sure to name it `FirebaseServiceAccount.json`. You will also need Firebase application credentials, which you should place in `secrets/` and name `FirebaseAppConfig.json`.

## Anatomy

There are two phases for deployment. The first phase consists of `BaseStack` and `SyncStack`. `BaseStack` consists of the DynamoDB table, S3 bucket, and Cognito User and Federated Identity Pools. `SyncStack` consists of the Step Functions machine that synchronizes data between Firestore and DynamoDB. As `SyncStack` is dependent on `BaseStack`, we need only deploy it to deploy both.

The second phase consists of `ApiStack` and `ListenerStack`. `ApiStack` is primarily the AppSync API and GraphQL schema definition generated from the synchronized Firestore data. `ListenerStack` consists of the ECS Fargate services that synchronize Firestore events in real time, Google Cloud Storage to S3, and Google Cloud Secrets Manager secrets to Systems Manager Parameter Store `SecureString` values.

The reason we split the overall deployment into two phases is because the first phase executes the Step Functions synchronization machine at deploy time. This ensures two things: 1/ We have a complete copy of Firestore, and 2/ We introspect the data and produce a GraphQL pseudo schema that feeds into the CDK code first GraphQL definition for the AppSync API.

## Deploying

This CDK application uses new style stack synthesis, so bootstrap with an explicit IAM policy:

```
cdk bootstrap --cloudformation-execution-policies \
  arn:aws:iam::aws:policy/AdministratorAccess
```

Build the app:

```
npm run build
```

Deploy the first phase:

```
cdk deploy <FIREBASE_PROJECT_ID>-SyncStack
```

Once these resources have stabilized, deploy the second phase:

```
cdk deploy <FIREBASE_PROJECT_ID>-ListenerStack
```

Other useful commands:

```
cdk ls|deploy|diff|destroy
```

To deploy to a particular AWS region, set the `CDK_DEPLOY_REGION` environment variable accordingly. The default region is `us-east-1`.

## Transforming Firestore to DynamoDB

We stick to some simple conventions in order to facilitate a generic transformation of a Firestore document-oriented schema to a single-table NoSQL schema.

We define the convention of a table _facet_, which is a logical embedded entity table defined by a GSI with partition key the entity type. As DynamoDB soft limits table GSIs to 20, dedicating one GSI for a logical entity type is efficient for single-table schema design, and allows for generic read and list operations by entity type. Furthermore, a facet of the schema logically corresponds to a GraphQL `__typename`.

We also define a GSI with partition key `__firestoreDocumentId` and sort key `__firestoreUpdatedAt` to allow for efficient access patterns by the Firestore document data in case the DynamoDB table schema uses an alternate primary key.

A natural mapping between Firestore documents and DynamoDB items exists:

<table>
  <thead>
    <tr>
      <th>Firestore</th>
      <th>DynamoDB</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Collection Name (Entity Type)</td>
      <td>GSI 1 partition key <code>__facet</code></td>
    </tr>
    <tr>
      <td rowspan=2><code>QueryDocumentSnapshot.id</code></td>
      <td>Table partition key <code>pk</code></td>
    </tr>
    <tr>
      <td>GSI 2 partition key <code>__firestoreDocumentId</code></td>
    </tr>
    <tr>
      <td rowspan=3><code>QueryDocumentSnapshot.updateTime</code></td>
      <td>Table sort key <code>sk</code></td>
    </tr>
    <tr>
      <td>GSI 1 sort key <code>sk</code></td>
    </tr>
    <tr>
      <td>GSI 2 sort key <code>__firestoreUpdatedAt</code></td>
    </tr>
  </tbody>
</table>


## GraphQL

### Authorization

This CDK application defaults the AppSync API to API key based authorization. It also deploys each Query, Mutation, and Subscription, as well as all generated first and second order GraphQL types, with AWS IAM and Cognito User Pool authorization.

Within the Cognito User Pool that is generated in this application, there is only one app client ID that is associated with the migrated Firebase application. Accordingly, there is only one User Pool Group called `Users` that all migrated or newly signed up users will belong to. This `Users` group is the authorized group explicitly associated with the GraphQL types described above.

### Read Operations

We enforce that GraphQL `get` operations assume the existence of a `key` field of type `ID` that logically maps to a DynamoDB partition key and sort key pair, where the sort key is optional, and is represented as the
concatenation of partition key and sort key with delimiter `|`. In regular expression we have:

    key ~= /pk(|sk)?/

We optionally define a GraphQL interface for a DynamoDB item primitive implemented by all first class GraphQL types, which includes a partition key, sort key, a key type expressed above, and meta attribute fields:

```GraphQL
interface ItemPrimitive {
  pk: String
  sk: String
  key: ID
  __firestoreDocumentId: String
  __firestoreUpdatedAt: AWSDateTime
}
```

This allows us to use non-default partition and sort key definitions in the DynamoDB schema, but retain the original Firestore document snapshot metadata. It also permits a meaningful way to perform DynamoDB item level query and get operations by way of a general Lambda resolver.

The utility of this interface is limited on the client side, and so by default, the DynamoDB GraphQL schema interpolation process does not define the `ItemPrimitive` interface.

### Complex Object Types

For the following discussion consider the following Firestore data, representing a plant growing in a user's gardens.

```json
{
  "totalGrowing": 123,
  "gardens": [
    "Front porch",
    "Back yard"
  ],
  "family": {
    "name": "Lamiaceae",
    "genus": {
      "name": "Mentha",
      "species": {
        "name": "M. spicata",
        "commonName": "Spearmint"
      }
    }
  }
}
```

#### Recursive GraphQL Generation
We generate a GraphQL schema from a single-table DynamoDB schema of migrated Firestore data by simply recursing on the incoming object types and map DynamoDB scalar fields to GraphQL scalar types, and DynamoDB container types to GraphQL list and object types. This is perhaps the most natural transformation between Firestore and DynamoDB. Other options have been explored that are not detailed here, allowing for efficient look into access patterns, but necessarily generate a more complex DynamoDB schema, so are not considered.

The DynamoDB item JSON is

```json
{
  "totalGrowing": { "N": 123 },
  "gardens": {
    "L": [
      { "S": "Front porch" },
      { "S": "Back yard" }
    ]
  },
  "family": {
    "M": {
      "name": { "S": "Lamiaceae" },
      "M": {
        "genus": {
          "name": { "S": "Mentha" },
          "M": {
            "species": {
              "name": { "S": "M. spicata" },
              "commonName": { "S": "Spearmint" }
            }
          }
        }
      }
    }
  }
}
```

with corresponding GraphQL schema

```graphql
type GardenPlantSpecies {
  name: String
  commonName: String
}

type GardenPlantGenus {
  name: String
  species: GardenPlantSpecies
}

type GardenPlantFamily {
  name: String
  genus: GardenPlantGenus
}

type GardenPlant {
  key: ID
  totalGrowing: Int
  gardens: [String]
  family: GardenPlantFamily
}
```
