import { Construct, RemovalPolicy } from "@aws-cdk/core";
import {
  AttributeType,
  BillingMode,
  Table as DynamoTable
} from "@aws-cdk/aws-dynamodb";

export interface TableProps {
  tableName: string;
}

export default class Table extends Construct {
  public readonly table: DynamoTable;

  constructor(scope: Construct, id: string, props: TableProps) {
    super(scope, id);

    this.table = new DynamoTable(this, id, {
      tableName: props.tableName,
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: {
        name: "pk",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "sk",
        type: AttributeType.STRING
      }
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "facet-sk-index",
      partitionKey: {
        name: "__facet",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "sk",
        type: AttributeType.STRING
      }
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "firestoreDocumentId-firestoreUpdatedAt-index",
      partitionKey: {
        name: "__firestoreDocumentId",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "__firestoreUpdatedAt",
        type: AttributeType.STRING
      }
    });
  }
}
