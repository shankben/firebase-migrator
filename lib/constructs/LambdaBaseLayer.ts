import path from "path";
import { Construct } from "@aws-cdk/core";
import { LayerVersion, Code, Runtime } from "@aws-cdk/aws-lambda";

export default class LambdaBaseLayer extends Construct {
  public readonly layerVersion: LayerVersion;

  private readonly assetPath = path.join(__dirname, "..", "..", "src",
    "lambda", "layers", "base");

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.layerVersion = new LayerVersion(this, id, {
      code: Code.fromAsset(this.assetPath),
      compatibleRuntimes: [Runtime.NODEJS_12_X],
      layerVersionName: "FirebaseIntegratorLambdaBaseLayer"
    });
  }
}
