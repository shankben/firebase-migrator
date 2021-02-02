import path from "path";
import { plural as pluralize } from "pluralize";

import {
  Arn,
  CfnOutput as StackOutput,
  Construct,
  Duration,
  Stack,
  StackProps
} from "@aws-cdk/core";

import {
  Code,
  Function as LambdaFunction,
  Runtime
} from "@aws-cdk/aws-lambda";

import {
  AuthorizationType,
  Directive,
  FieldLogLevel,
  GraphqlApi,
  GraphqlType,
  LambdaDataSource,
  MappingTemplate,
  ObjectType,
  ResolvableField
} from "@aws-cdk/aws-appsync";

import { Role, PolicyStatement } from "@aws-cdk/aws-iam";
import { Bucket } from "@aws-cdk/aws-s3";
import { RetentionDays } from "@aws-cdk/aws-logs";

import LambdaBaseLayer from "../constructs/LambdaBaseLayer";
import Table from "../constructs/Table";
import UserAuth from "../constructs/UserAuth";

import {
  PseudoGraphqlSchema,
  getMetaItem,
  hydratePseudoSchema
} from "../utils";

export interface ApiStackProps extends StackProps {
  bucket: Bucket;
  firebaseProjectId: string;
  userAuth: UserAuth;
  table: Table;
}

export default class ApiStack extends Stack {
  private readonly assetPath = path
    .join(__dirname, "..", "..", "assets", "lambda");

  private readonly userAuth: UserAuth;
  public readonly api: GraphqlApi;

  private async generateGraphqlSchema(
    api: GraphqlApi,
    dataSource: LambdaDataSource,
    tableName: string
  ) {
    let metaItem;

    try {
      metaItem = await getMetaItem(tableName);
    } catch (err) {
      return;
    }

    const pseudoSchema = hydratePseudoSchema(metaItem.pseudoSchema);

    const authorizationTypes = [
      Directive.apiKey(),
      Directive.cognito(this.userAuth.usersGroup.groupName!),
      Directive.iam()
    ];

    pseudoSchema.forEach((spec: PseudoGraphqlSchema) => {
      const [rootType, inputType] = spec.rootTypes;

      api.addType(new ObjectType(rootType.name, {
        ...rootType,
        directives: [...authorizationTypes]
      }));

      api.addType(inputType);

      spec.intermediateTypes.forEach(([objectType, inputType]) => {
        api.addType(objectType);
        api.addType(inputType);
      });

      //// Queries
      api.addQuery(`get${rootType.name}`, new ResolvableField({
        dataSource: dataSource,
        directives: [...authorizationTypes],
        requestMappingTemplate: MappingTemplate.lambdaRequest(),
        responseMappingTemplate: MappingTemplate.lambdaResult(),
        returnType: rootType.attribute(),
        args: { key: GraphqlType.id({ isRequired: true }) }
      }));

      api.addQuery(pluralize(`list${rootType.name}`), new ResolvableField({
        dataSource: dataSource,
        directives: [...authorizationTypes],
        requestMappingTemplate: MappingTemplate.lambdaRequest(),
        responseMappingTemplate: MappingTemplate.lambdaResult(),
        returnType: rootType.attribute({ isList: true })
      }));

      //// Subscriptions
      api.addSubscription(`updated${rootType.name}`, new ResolvableField({
        dataSource: dataSource,
        directives: [
          ...authorizationTypes,
          Directive.subscribe(`update${rootType.name}`)
        ],
        requestMappingTemplate: MappingTemplate.lambdaRequest(),
        responseMappingTemplate: MappingTemplate.lambdaResult(),
        returnType: rootType.attribute()
      }));

      //// Mutations
      api.addMutation(`update${rootType.name}`, new ResolvableField({
        dataSource: dataSource,
        directives: [...authorizationTypes],
        requestMappingTemplate: MappingTemplate.lambdaRequest(),
        responseMappingTemplate: MappingTemplate.lambdaResult(),
        returnType: rootType.attribute(),
        args: { input: inputType.attribute({ isRequired: true }) }
      }));
    });
  }

  private attachPolicies(props: ApiStackProps) {
    const allowAppSync = new PolicyStatement({
      actions: ["appsync:GraphQL"],
      resources: [
        Arn.format({
          service: "appsync",
          resource: `apis/${this.api.apiId}/*`
        }, this)
      ]
    });
    const attachPolicy = (prefix: string) => Role.fromRoleArn(
      this,
      `AllowAppSync-${prefix}Role`,
      (props.userAuth as Record<string, any>)[`${prefix}thenticatedRole`]
        .roleArn
    ).addToPrincipalPolicy(allowAppSync);
    attachPolicy("unau");
    attachPolicy("au");
  }

  constructor(
    scope: Construct,
    id: string,
    props: ApiStackProps
  ) {
    super(scope, id, props);

    this.userAuth = props.userAuth;

    const lambdaBaseLayer = new LambdaBaseLayer(this, "LambdaBaseLayer");

    //// AppSync API
    const authorizationConfig = {
      additionalAuthorizationModes: [
        { authorizationType: AuthorizationType.API_KEY },
        {
          authorizationType: AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: props.userAuth.userPool,
            appIdClientRegex: props.userAuth.appUserPoolClient
              .userPoolClientId
          }
        }
      ],
      defaultAuthorization: {
        authorizationType: AuthorizationType.IAM
      }
    };
    this.api = new GraphqlApi(this, "GraphqlApi", {
      name: props.firebaseProjectId,
      logConfig: { fieldLogLevel: FieldLogLevel.ALL },
      authorizationConfig
    });

    this.attachPolicies(props);

    const dynamoResolverFn = new LambdaFunction(this, "DynamoResolverFn", {
      functionName: "UberDynamoDBResolver",
      code: Code.fromAsset(path.join(this.assetPath,
        "appsync-resolvers", "uber-dynamodb-resolver")),
      runtime: Runtime.NODEJS_12_X,
      timeout: Duration.minutes(1),
      memorySize: 3008,
      handler: "index.handler",
      logRetention: RetentionDays.ONE_DAY,
      layers: [lambdaBaseLayer.layerVersion],
      environment: {
        TABLE_NAME: props.table.table.tableName
      }
    });

    props.table.table.grantReadWriteData(dynamoResolverFn);

    const dataSource = this.api.addLambdaDataSource(
      "LambdaDataSource",
      dynamoResolverFn,
      { name: "LambdaDataSource" }
    );

    (async () => this.generateGraphqlSchema(
      this.api,
      dataSource,
      props.firebaseProjectId
    ))();

    //// Outputs
    new StackOutput(this, "AmplifyConfigAppSyncApiId", {
      value: this.api.apiId
    });

    new StackOutput(this, "AmplifyConfigOutput", {
      value: JSON.stringify({
        aws_appsync_graphqlEndpoint: this.api.graphqlUrl,
        aws_appsync_region: Stack.of(this).region,
        aws_appsync_authenticationType: authorizationConfig.defaultAuthorization
          .authorizationType,
        Auth: {
          region: Stack.of(this).region,
          identityPoolRegion: Stack.of(this).region,
          identityPoolId: this.userAuth.identityPool.ref,
          userPoolId: this.userAuth.userPool.userPoolId,
          userPoolWebClientId: this.userAuth.appUserPoolClient.userPoolClientId,
          authenticationFlowType: "USER_PASSWORD_AUTH" // FIXME
        },
        Storage: {
          AWSS3: {
            region: Stack.of(this).region,
            bucket: props.bucket.bucketName
          }
        }
      })
    });
  }
}
