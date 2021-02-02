import crypto from "crypto";
import path from "path";

import {
  Arn,
  Construct,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps
} from "@aws-cdk/core";

import {
  Choice,
  Condition,
  JsonPath,
  LogLevel,
  StateMachine,
  Succeed,
  TaskInput
} from "@aws-cdk/aws-stepfunctions";

import { PolicyStatement } from "@aws-cdk/aws-iam";
import { LambdaInvoke, SqsSendMessage } from "@aws-cdk/aws-stepfunctions-tasks";
import { Code, Runtime, Function as LambdaFunction } from "@aws-cdk/aws-lambda";
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "@aws-cdk/aws-logs";
import { Queue } from "@aws-cdk/aws-sqs";

import LambdaBaseLayer from "../constructs/LambdaBaseLayer";
import SyncMachineExecution from "../constructs/SyncMachineExecution";
import Table from "../constructs/Table";

export interface FirestoreSyncStackProps extends StackProps {
  firebaseProjectId: string;
  table: Table;
}

export default class FirestoreSyncStack extends Stack {
  public readonly execution: SyncMachineExecution;

  private readonly readerTimeoutMinutes = 5;

  private readonly assetPath = path
    .join(__dirname, "..", "..", "assets", "lambda", "sync");

  private readonly allowSsm = new PolicyStatement({
    resources: [
      Arn.format({ service: "ssm", resource: "parameter/Firebase*" }, this)
    ],
    actions: [
      "ssm:GetParameter",
      "ssm:GetParameters"
    ]
  });

  constructor(scope: Construct, id: string, props: FirestoreSyncStackProps) {
    super(scope, id, props);

    const { table } = props;

    const lambdaBaseLayer = new LambdaBaseLayer(this, "LambdaBaseLayer");

    const queue = new Queue(this, "Queue", {
      queueName: "FirebaseSyncQueue",
      visibilityTimeout: Duration.minutes(6 * this.readerTimeoutMinutes),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: new Queue(this, "DLQ", {
          queueName: "FirebaseSyncDeadLetterQueue"
        })
      }
    });

    const lambdaProps = {
      handler: "index.handler",
      initialPolicy: [this.allowSsm],
      layers: [lambdaBaseLayer.layerVersion],
      logRetention: RetentionDays.ONE_DAY,
      memorySize: 3008,
      runtime: Runtime.NODEJS_12_X,
      timeout: Duration.minutes(this.readerTimeoutMinutes),
      environment: {
        TABLE_NAME: table.table.tableName,
        FIREBASE_PROJECT_ID: props.firebaseProjectId
      }
    };

    const primer = new LambdaInvoke(this, "Primer", {
      payloadResponseOnly: true,
      resultPath: "$.primer",
      lambdaFunction: new LambdaFunction(this, "PrimerFn", {
        ...lambdaProps,
        code: Code.fromAsset(path.join(this.assetPath, "primer")),
        functionName: "FirebaseSyncPrimer"
      })
    });

    const reader = new LambdaInvoke(this, "Reader", {
      payloadResponseOnly: true,
      resultPath: "$.reader",
      lambdaFunction: (() => {
        const fn = new LambdaFunction(this, "ReaderFn", {
          ...lambdaProps,
          code: Code.fromAsset(path.join(this.assetPath, "reader")),
          functionName: "FirebaseSyncReader",
          environment: {
            ...lambdaProps.environment,
            WRITE_QUEUE_URL: queue.queueUrl
          }
        });
        table.table.grantReadWriteData(fn);
        queue.grant(fn, "sqs:GetQueueAttributes");
        return fn;
      })()
    });

    const writer = new LambdaFunction(this, "WriterFn", {
      ...lambdaProps,
      code: Code.fromAsset(path.join(this.assetPath, "writer")),
      functionName: "FirebaseSyncWriter"
    });
    table.table.grantReadWriteData(writer);
    writer.addEventSource(new SqsEventSource(queue));

    const introspector = new LambdaInvoke(this, "Introspector", {
      payloadResponseOnly: true,
      resultPath: "$.introspector",
      lambdaFunction: (() => {
        const fn = new LambdaFunction(this, "IntrospectorFn", {
          ...lambdaProps,
          code: Code.fromAsset(path.join(this.assetPath, "introspector")),
          functionName: "FirebaseSyncIntrospector"
        });
        table.table.grantReadWriteData(fn);
        return fn;
      })()
    });

    const machine = new StateMachine(this, "StateMachine", {
      stateMachineName: "FirebaseSyncMachine",
      logs: {
        level: LogLevel.ALL,
        destination: new LogGroup(this, "LogGroup", {
          logGroupName: "/aws/states/FirebaseSyncMachine",
          removalPolicy: RemovalPolicy.DESTROY,
          retention: RetentionDays.ONE_DAY
        })
      },
      definition: primer
        .next(reader)
        .next(new SqsSendMessage(this, "QueueWrite", {
          queue,
          messageBody: TaskInput.fromJsonPathAt("$.reader.docs"),
          resultPath: JsonPath.DISCARD
        }))
        .next(new Choice(this, "ShouldStop")
          .when(Condition.booleanEquals("$.reader.continue", true), reader)
          .otherwise(introspector
            .next(new Succeed(this, "Done"))))
    });

    this.execution = new SyncMachineExecution(
      this,
      `SyncMachineExecution-${crypto.randomBytes(6).toString("base64")}`,
      { machine }
    );
  }
}
