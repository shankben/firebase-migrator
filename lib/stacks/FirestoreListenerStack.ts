import path from "path";

import {
  Arn,
  Construct,
  Duration,
  Stack,
  StackProps,
  RemovalPolicy
} from "@aws-cdk/core";

import {
  Cluster as EcsCluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDriver
} from "@aws-cdk/aws-ecs";

import { GraphqlApi } from "@aws-cdk/aws-appsync";
import { Schedule } from "@aws-cdk/aws-applicationautoscaling";
import { ScheduledFargateTask } from "@aws-cdk/aws-ecs-patterns";
import { Vpc, SubnetType } from "@aws-cdk/aws-ec2";
import { PolicyStatement } from "@aws-cdk/aws-iam";
import { LogGroup, RetentionDays } from "@aws-cdk/aws-logs";
import { Bucket } from "@aws-cdk/aws-s3";

import Table from "../constructs/Table";

export interface FirestoreListenerStackProps extends StackProps {
  api: GraphqlApi;
  bucket: Bucket;
  firebaseProjectId: string;
  table: Table;
}

export default class FirestoreListenerStack extends Stack {
  private readonly assetPath = path
    .join(__dirname, "..", "..", "src", "fargate");

  private readonly allowReadSsm = new PolicyStatement({
    actions: [
      "ssm:GetParameter",
      "ssm:GetParameters"
    ],
    resources: [
      Arn.format({ service: "ssm", resource: "parameter/Firebase*" }, this)
    ]
  });

  private readonly allowCfn = new PolicyStatement({
    actions: ["cloudformation:DescribeStacks"],
    resources: [
      Arn.format({ service: "cloudformation", resource: "stack/*" }, this)
    ]
  });

  private makeFirestoreListenerTaskDef(
    props: FirestoreListenerStackProps
  ): FargateTaskDefinition {
    const taskDefinition = new FargateTaskDefinition(this, "FLTaskDef", {
      family: "FirestoreListenerTask"
    });
    taskDefinition.addToTaskRolePolicy(this.allowReadSsm);
    taskDefinition.addToTaskRolePolicy(this.allowCfn);
    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      actions: ["appsync:GraphQL"],
      resources: [
        Arn.format({
          service: "appsync",
          resource: `apis/${props.api.apiId}/*`
        }, this)
      ]
    }));
    props.table.table.grantReadWriteData(taskDefinition.taskRole);
    taskDefinition.addContainer("FirestoreListener", {
      image: ContainerImage.fromAsset(path
        .join(this.assetPath, "firebase-listener-proxy")),
      logging: LogDriver.awsLogs({
        streamPrefix: "FirestoreListener",
        logGroup: new LogGroup(this, "FLLogGroup", {
          logGroupName: "/aws/ecs/FirestoreListener",
          retention: RetentionDays.ONE_DAY,
          removalPolicy: RemovalPolicy.DESTROY
        })
      }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        TABLE_NAME: props.table.table.tableName,
        FIREBASE_PROJECT_ID: props.firebaseProjectId
      }
    });
    return taskDefinition;
  }

  private makeScheduledTaskDefinition(
    name: string,
    assetPath: string,
    policies: PolicyStatement[],
    props: FirestoreListenerStackProps
  ): FargateTaskDefinition {
    const taskDefinition = new FargateTaskDefinition(this, `${name}TaskDef`, {
      family: `${name}Task`,
      memoryLimitMiB: 1024
    });
    policies.forEach((it) => taskDefinition.addToTaskRolePolicy(it));
    taskDefinition.addContainer(name, {
      image: ContainerImage.fromAsset(path.join(this.assetPath, assetPath)),
      logging: LogDriver.awsLogs({
        streamPrefix: name,
        logGroup: new LogGroup(this, `${name}LogGroup`, {
          logGroupName: `/aws/ecs/${name}`,
          retention: RetentionDays.ONE_DAY,
          removalPolicy: RemovalPolicy.DESTROY
        })
      }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        FIREBASE_PROJECT_ID: props.firebaseProjectId
      }
    });
    return taskDefinition;
  }

  constructor(
    scope: Construct,
    id: string,
    props: FirestoreListenerStackProps
  ) {
    super(scope, id, props);

    const vpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const cluster = new EcsCluster(this, "EcsCluster", {
      vpc,
      clusterName: "firebase-migrator"
    });

    new ScheduledFargateTask(this, "BucketSynchronizerScheduledTask", {
      cluster,
      schedule: Schedule.rate(Duration.minutes(15)),
      subnetSelection: {
        subnetType: SubnetType.PUBLIC
      },
      scheduledFargateTaskDefinitionOptions: {
        taskDefinition: (() => {
          const taskDefinition = this.makeScheduledTaskDefinition(
            "BucketSynchronizer",
            "bucket-synchronizer",
            [this.allowCfn, this.allowReadSsm],
            props
          );
          props.bucket.grantReadWrite(taskDefinition.taskRole);
          return taskDefinition;
        })()
      }
    });

    new ScheduledFargateTask(this, "SecretsSynchronizerScheduledTask", {
      cluster,
      schedule: Schedule.rate(Duration.minutes(15)),
      subnetSelection: {
        subnetType: SubnetType.PUBLIC
      },
      scheduledFargateTaskDefinitionOptions: {
        taskDefinition: this.makeScheduledTaskDefinition(
          "SecretsSynchronizer",
          "secrets-synchronizer",
          [
            this.allowCfn,
            this.allowReadSsm,
            new PolicyStatement({
              actions: ["ssm:PutParameter"],
              resources: [
                Arn.format({
                  service: "ssm",
                  resource: "parameter/Firebase*"
                }, this)
              ]
            })
          ],
          props
        )
      }
    });

    new FargateService(this, "FirestoreListenerService", {
      assignPublicIp: true,
      cluster,
      desiredCount: 1,
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      serviceName: "FirestoreListenerProxy",
      taskDefinition: this.makeFirestoreListenerTaskDef(props)
    });
  }
}
