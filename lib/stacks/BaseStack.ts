import {
  Construct,
  PhysicalName,
  Stack,
  StackProps
} from "@aws-cdk/core";

import { Bucket, HttpMethods } from "@aws-cdk/aws-s3";

import LambdaBaseLayer from "../constructs/LambdaBaseLayer";
import Table from "../constructs/Table";
import UserAuth from "../constructs/UserAuth";

export interface BaseStackProps extends StackProps {
  firebaseProjectId: string;
}

export default class BaseStack extends Stack {
  public readonly bucket: Bucket;
  public readonly table: Table;
  public readonly userAuth: UserAuth;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);

    const { firebaseProjectId } = props;

    const lambdaBaseLayer = new LambdaBaseLayer(this, "LambdaBaseLayer");

    //// DynamoDB
    this.table = new Table(this, "Table", { tableName: firebaseProjectId });

    //// S3 Bucket
    this.bucket = new Bucket(this, "Bucket", {
      bucketName: PhysicalName.GENERATE_IF_NEEDED,
      cors: [{
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
        maxAge: 3000,
        allowedMethods: [
          HttpMethods.DELETE,
          HttpMethods.GET,
          HttpMethods.HEAD,
          HttpMethods.POST,
          HttpMethods.PUT
        ],
        exposedHeaders: [
          "x-amz-server-side-encryption",
          "x-amz-request-id",
          "x-amz-id-2",
          "ETag"
        ]
      }]
    });

    //// Cognito
    this.userAuth = new UserAuth(this, "UserAuth", {
      userPoolName: firebaseProjectId,
      bucket: this.bucket,
      lambdaBaseLayer,
      firebaseProjectId
    });
  }
}
