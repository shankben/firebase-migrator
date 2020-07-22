import path from "path";
import { RetentionDays } from "@aws-cdk/aws-logs";
import { Bucket } from "@aws-cdk/aws-s3";

import {
  Arn,
  Construct,
  Duration,
  Stack
} from "@aws-cdk/core";

import {
  Code,
  Function as LambdaFunction,
  LayerVersion,
  Runtime
} from "@aws-cdk/aws-lambda";

import {
  FederatedPrincipal,
  PolicyStatement,
  Role
} from "@aws-cdk/aws-iam";

import {
  UserPool,
  Mfa,
  UserPoolClient,
  UserPoolDomain,
  CfnUserPoolGroup,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  StringAttribute
} from "@aws-cdk/aws-cognito";

import LambdaBaseLayer from "./LambdaBaseLayer";

export interface UserAuthProps {
  bucket: Bucket;
  userPoolName: string;
  lambdaBaseLayer: LambdaBaseLayer;
  firebaseProjectId: string;
}

export default class UserAuth extends Construct {
  private readonly assetPath = path.join(__dirname, "..", "..", "src",
    "lambda", "cognito-triggers");

  public readonly authenticatedRole: Role;
  public readonly unauthenticatedRole: Role;
  public readonly usersGroup: CfnUserPoolGroup;
  public readonly identityPool: CfnIdentityPool;
  public readonly appUserPoolClient: UserPoolClient;
  public readonly userPool: UserPool;

  private readonly userGroupName = "Users";

  private setBucketPolicies(bucketArn: string) {
    this.authenticatedRole.addToPolicy(new PolicyStatement({
      resources: [
        bucketArn + "/public/*",
        bucketArn + "/protected/${cognito-identity.amazonaws.com:sub}/*",
        bucketArn + "/private/${cognito-identity.amazonaws.com:sub}/*"
      ],
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ]
    }));

    this.authenticatedRole.addToPolicy(new PolicyStatement({
      resources: [`${bucketArn}/uploads/*`],
      actions: ["s3:PutObject"]
    }));

    this.authenticatedRole.addToPolicy(new PolicyStatement({
      resources: [`${bucketArn}/protected/*`],
      actions: ["s3:GetObject"]
    }));

    this.authenticatedRole.addToPolicy(new PolicyStatement({
      resources: [bucketArn],
      actions: ["s3:ListBucket"],
      conditions: {
        "StringLike": {
          "s3:prefix": [
            "public/",
            "public/*",
            "protected/",
            "protected/*",
            "private/${cognito-identity.amazonaws.com:sub}/",
            "private/${cognito-identity.amazonaws.com:sub}/*"
          ]
        }
      }
    }));

    this.unauthenticatedRole.addToPolicy(new PolicyStatement({
      resources: [`${bucketArn}/public/*`],
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ]
    }));

    this.unauthenticatedRole.addToPolicy(new PolicyStatement({
      resources: [`${bucketArn}/uploads/*`],
      actions: ["s3:PutObject"]
    }));

    this.unauthenticatedRole.addToPolicy(new PolicyStatement({
      resources: [`${bucketArn}/protected/*`],
      actions: ["s3:GetObject"]
    }));

    this.unauthenticatedRole.addToPolicy(new PolicyStatement({
      resources: [bucketArn],
      actions: ["s3:ListBucket"],
      conditions: {
        "StringLike": {
          "s3:prefix": [
            "public/",
            "public/*",
            "protected/",
            "protected/*"
          ]
        }
      }
    }));
  }

  private makeRole(type: string, name = "") {
    return new Role(this, `Cognito${name}${type}uthRole`, {
      roleName: `FirebaseSyncCognito${name}${type}uthRole`,
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": this.identityPool.ref
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr":
              `${type.toLowerCase()}uthenticated`
          }
        },
        "sts:AssumeRoleWithWebIdentity"
      )
    });
  }

  private makeMigrationTrigger(props: UserAuthProps) {
    return new LambdaFunction(this, "UserMigrator", {
      functionName: "FirebaseSyncUserMigrator",
      logRetention: RetentionDays.ONE_DAY,
      code: Code.fromAsset(path.join(this.assetPath, "user-migrator")),
      retryAttempts: 0,
      runtime: Runtime.NODEJS_12_X,
      timeout: Duration.minutes(1),
      memorySize: 3008,
      handler: "index.handler",
      layers: [props.lambdaBaseLayer.layerVersion],
      environment: { FIREBASE_PROJECT_ID: props.firebaseProjectId },
      initialPolicy: [
        new PolicyStatement({
          resources: [
            Arn.format(
              { service: "ssm", resource: "parameter/Firebase*" },
              Stack.of(this)
            )
          ],
          actions: [
            "ssm:GetParameter",
            "ssm:GetParameters"
          ]
        })
      ]
    });
  }

  private makePostAuthenticationTrigger(layerVersion: LayerVersion) {
    return new LambdaFunction(this, "PostAuthenticationTrigger", {
      functionName: "FirebaseSyncPostAuthentication",
      logRetention: RetentionDays.ONE_DAY,
      code: Code.fromAsset(path.join(this.assetPath, "post-authentication")),
      retryAttempts: 0,
      runtime: Runtime.NODEJS_12_X,
      timeout: Duration.minutes(1),
      memorySize: 3008,
      handler: "index.handler",
      layers: [layerVersion],
      environment: { USER_GROUP_NAME: this.userGroupName },
      initialPolicy: [
        new PolicyStatement({
          resources: [
            Arn.format(
              { service: "cognito-idp", resource: "userpool/*" },
              Stack.of(this)
            )
          ],
          actions: ["cognito-idp:AdminAddUserToGroup"]
        })
      ]
    });
  }

  constructor(scope: Construct, id: string, props: UserAuthProps) {
    super(scope, id);

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: props.userPoolName,
      selfSignUpEnabled: true,
      mfa: Mfa.OPTIONAL,
      customAttributes: {
        firebaseUserId: new StringAttribute({
          minLen: 28,
          maxLen: 28,
          mutable: false
        })
      },
      passwordPolicy: {
        minLength: 6,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: false
      },
      signInAliases: {
        phone: false,
        email: true,
        preferredUsername: true,
        username: true
      },
      lambdaTriggers: {
        userMigration: this.makeMigrationTrigger(props),
        postAuthentication: this.makePostAuthenticationTrigger(
          props.lambdaBaseLayer.layerVersion
        )
      }
    });

    //// App client
    // const pinpointAppId = scope.pinpointApp.ref;
    // const pinpointArn = "arn:aws:mobiletargeting:" +
    //   [region, accountId].join(":") + `:apps/${pinpointAppId}`;
    // const pinpointRole = new Role(
    //   this,
    //   "AppClientPinpointRole",
    //   { assumedBy: new ServicePrincipal("cognito-idp.amazonaws.com") }
    // );
    // new Policy(this, "AppClientPinpointPolicy", {
    //   policyName: "AppClientPinpointPolicy",
    //   roles: [pinpointRole],
    //   statements: [
    //     new PolicyStatement({
    //       resources: [`${pinpointArn}/endpoints/*`],
    //       actions: ["mobiletargeting:UpdateEndpoint"]
    //     }),
    //     new PolicyStatement({
    //       resources: ["*"],
    //       actions: ["mobileanalytics:PutItems"]
    //     })
    //   ]
    // });
    // const appClientProps = {
    //   analyticsConfiguration: {
    //     applicationId: pinpointAppId,
    //     externalId: this.userPool.ref,
    //     roleArn: pinpointRole.roleArn,
    //     userDataShared: true
    //   },
    //   generateSecret: false,
    //   clientName: "AppClient",
    //   userPoolId: this.userPool.ref,
    //   explicitAuthFlows: ["ADMIN_NO_SRP_AUTH"] // TODO: Disable in production
    // };

    this.appUserPoolClient = new UserPoolClient(this, "AppClient", {
      userPool: this.userPool,
      userPoolClientName: `AppClient-${props.userPoolName}`,
      disableOAuth: true,
      authFlows: {
        userPassword: true,
        userSrp: true
      }
    });

    new UserPoolDomain(this, "UserPoolDomain", {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: props.userPoolName
      }
    });

    //// Identity pool
    this.identityPool = new CfnIdentityPool(this, "IdentityPool", {
      allowUnauthenticatedIdentities: true,
      identityPoolName: props.userPoolName,
      cognitoIdentityProviders: [
        {
          clientId: this.appUserPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
          serverSideTokenCheck: true
        }
      ]
    });

    // Identity pool roles
    this.authenticatedRole = this.makeRole("A");
    this.unauthenticatedRole = this.makeRole("Una");
    this.setBucketPolicies(props.bucket.bucketArn);

    this.usersGroup = new CfnUserPoolGroup(this, "UsersGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: this.userGroupName,
      roleArn: this.authenticatedRole.roleArn
    });

    // const pinpointArn = `arn:aws:mobiletargeting:${this.region}:` +
    //   `${this.accountId}:apps/${pinpointAppId}`;
    // const pinpointPolicyStatement = new PolicyStatement({
    //   resources: [`${pinpointArn}*`],
    //   actions: [
    //     "mobiletargeting:GetUserEndpoints",
    //     "mobiletargeting:PutEvents",
    //     "mobiletargeting:UpdateEndpoint"
    //   ]
    // });
    // this.authenticatedRole.addToPolicy(pinpointPolicyStatement);
    // this.authenticatedRole.addManagedPolicy(ManagedPolicy
    //   .fromAwsManagedPolicyName("AWSIoTDataAccess"));
    // this.authenticatedRole.addManagedPolicy(ManagedPolicy
    //   .fromAwsManagedPolicyName("AWSIoTConfigAccess"));
    // this.unauthenticatedRole.addToPolicy(pinpointPolicyStatement);

    new CfnIdentityPoolRoleAttachment(this, "IdentityPoolAttachment", {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
        unauthenticated: this.unauthenticatedRole.roleArn
      },
      // roleMappings: {
      //   "appUserPoolClient": {
      //     identityProvider:
      //       `cognito-idp.${Stack.of(this).region}.amazonaws.com/` +
      //       this.userPool.userPoolArn + `:` +
      //       this.appUserPoolClient.userPoolClientId,
      //     type: "Rules",
      //     ambiguousRoleResolution: "AuthenticatedRole",
      //     rulesConfiguration: {
      //       rules: [
      //         {
      //           claim: "cognito:groups",
      //           matchType: "Contains",
      //           value: usersGroup.groupName!,
      //           roleArn: this.authenticatedRole.roleArn
      //         }
      //       ]
      //     }
      //   }
      // }
    });
  }
}
