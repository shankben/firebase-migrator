import path from "path";

import {
  Stack,
  Construct,
  CustomResource,
  IDependable
} from "@aws-cdk/core";

import {
  Function as LambdaFunction,
  Code,
  Runtime
} from "@aws-cdk/aws-lambda";

import { RetentionDays } from "@aws-cdk/aws-logs";
import { StateMachine } from "@aws-cdk/aws-stepfunctions";
import { Provider } from "@aws-cdk/custom-resources";
import { PolicyStatement } from "@aws-cdk/aws-iam";


export interface SyncMachineExecutionProps {
  machine: StateMachine;
}

export default class SyncMachineExecution extends Construct {
  private readonly RESOURCE_TYPE = `Custom::${SyncMachineExecutionProvider.ID}`;
  private readonly resource: CustomResource;

  public get result() {
    return this.resource.getAttString("executionArn");
  }

  public addDependency(...dependencies: IDependable[]): void {
    this.resource.node.addDependency(dependencies);
  }

  constructor(scope: Construct, id: string, props: SyncMachineExecutionProps) {
    super(scope, id);
    this.resource = new CustomResource(this, "Resource", {
      resourceType: this.RESOURCE_TYPE,
      serviceToken: SyncMachineExecutionProvider.getOrCreate(this),
      properties: {
        stateMachineArn: props.machine.stateMachineArn
      }
    });
  }
}

class SyncMachineExecutionProvider extends Construct {
  public static readonly ID = "SyncMachineExecutionWithResult";

  public static getOrCreate(scope: Construct) {
    const stack = Stack.of(scope);
    const { ID: id } = SyncMachineExecutionProvider;
    return (stack.node.tryFindChild(id) as SyncMachineExecutionProvider ??
      new SyncMachineExecutionProvider(stack, id)).provider.serviceToken;
  }

  private readonly provider: Provider;
  private readonly assetPath = path.join(__dirname, "..", "..", "assets",
    "lambda");

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const props = {
      code: Code.fromAsset(path.join(this.assetPath, "sync", "execution")),
      runtime: Runtime.NODEJS_12_X,
      logRetention: RetentionDays.ONE_DAY
    };

    const onEventHandler = new LambdaFunction(this, "OnEvent", {
      ...props,
      functionName: "FirebaseSyncMachineExecutionOnEvent",
      handler: "index.onEvent",
      initialPolicy: [
        new PolicyStatement({
          resources: ["*"],
          actions: ["states:StartExecution"]
        })
      ]
    });

    const isCompleteHandler = new LambdaFunction(this, "IsComplete", {
      ...props,
      functionName: "FirebaseSyncMachineExecutionIsComplete",
      handler: "index.isComplete",
      initialPolicy: [
        new PolicyStatement({
          resources: ["*"],
          actions: ["states:DescribeExecution"]
        }),
        new PolicyStatement({
          resources: ["*"],
          actions: ["sqs:GetQueueAttributes"]
        })
      ]
    });

    this.provider = new Provider(this, "Provider", {
      onEventHandler,
      isCompleteHandler,
      logRetention: RetentionDays.ONE_DAY
    });
  }
}
