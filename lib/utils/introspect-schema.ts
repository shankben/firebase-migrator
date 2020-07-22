import * as AWS from "aws-sdk";

import { singular as singularize } from "pluralize";

import {
  GraphqlType,
  GraphqlTypeOptions,
  IField,
  IIntermediateType,
  ObjectType,
  InputType,
  Type
} from "@aws-cdk/aws-appsync";

import {
  AttributeMap,
  AttributeValue,
  Converter
} from "aws-sdk/clients/dynamodb";

import {
  capitalize,
  firstKey,
  isDateTime,
  setIntersect,
  getMetaItem
} from "./";

const REGION = process.env.CDK_DEPLOY_REGION ??
  process.env.CDK_DEFAULT_REGION ??
  "us-east-1";

AWS.config.update({ region: REGION });
const dynamodb = new AWS.DynamoDB();

const DYNAMO_FLAT_TYPES = new Set(["BOOL", "S", "N"]);

export interface PseudoGraphqlSchema {
  rootTypes: [ObjectType, InputType];
  intermediateTypes: [ObjectType, InputType][];
}

interface MakeTypeOptions extends GraphqlTypeOptions {
  facet: string;
  name: string;
}

interface MakeTypeResult {
  scalarType?: GraphqlType;
  objectType?: ObjectType;
  inputType?: InputType;
  options?: MakeTypeOptions;
}

type MakeTypeResults = {[k: string]: MakeTypeResult};
type GraphqlTypeDefinition = {[k: string]: IField};

const isScalar = (item: AttributeValue): boolean => DYNAMO_FLAT_TYPES
  .has(Object.keys(item)[0]!);

const isListOfScalars = (item: AttributeValue): boolean => {
  const attrType = Object.keys(item)[0];
  if (attrType !== "L") return false;
  const list: AttributeValue[] = item.L || [];
  if (list.length === 0) return true;
  return list.map(isScalar).reduce((x, y) => x && y, true);
};

const unwindIntermediateTypes = (
  spec: IIntermediateType
): IIntermediateType[] => {
  const unwind = (spec: IIntermediateType) => Object
    .values(spec.definition)
    .filter((it) => it.type === Type.INTERMEDIATE)
    .map((it) => it.intermediateType);
  const out = [];
  const children = unwind(spec);
  while (children.length) {
    const next = children.shift()!;
    out.push(next);
    children.concat(unwind(next));
  }
  return out;
};

const makeScalarType = (
  type: Type,
  options: GraphqlTypeOptions = {}
): GraphqlType | undefined => {
  switch (type) {
    case Type.AWS_DATE: return GraphqlType.awsDate(options);
    case Type.AWS_DATE_TIME: return GraphqlType.awsDateTime(options);
    case Type.AWS_EMAIL: return GraphqlType.awsEmail(options);
    case Type.AWS_IP_ADDRESS: return GraphqlType.awsIpAddress(options);
    case Type.AWS_JSON: return GraphqlType.awsJson(options);
    case Type.AWS_PHONE: return GraphqlType.awsPhone(options);
    case Type.AWS_TIME: return GraphqlType.awsTime(options);
    case Type.AWS_TIMESTAMP: return GraphqlType.awsTimestamp(options);
    case Type.AWS_URL: return GraphqlType.awsUrl(options);
    case Type.BOOLEAN: return GraphqlType.boolean(options);
    case Type.FLOAT: return GraphqlType.float(options);
    case Type.ID: return GraphqlType.id(options);
    case Type.INT: return GraphqlType.int(options);
    case Type.STRING: return GraphqlType.string(options);
    case Type.INTERMEDIATE: return GraphqlType.intermediate(options);
    default: return;
  }
};

const copyScalarType = (
  graphqlType: GraphqlType,
  options: GraphqlTypeOptions = {}
): GraphqlType => {
  const opts: GraphqlTypeOptions = {
    isList: graphqlType.isList,
    isRequired: graphqlType.isRequired,
    isRequiredList: graphqlType.isRequiredList,
    ...options
  };
  const out = makeScalarType(graphqlType.type, opts);
  if (!out) return graphqlType; else return out;
};

const makeGraphqlTypes = (
  name: string,
  results: MakeTypeResults
): [ObjectType, InputType] => {
  const objectDefinition: GraphqlTypeDefinition = {};
  const inputDefinition: GraphqlTypeDefinition = {};
  Object.keys(results).forEach((fieldName) => {
    const res = results[fieldName];
    if (res.scalarType) {
      objectDefinition[fieldName] = copyScalarType(res.scalarType, res.options);
      inputDefinition[fieldName] = copyScalarType(res.scalarType, {
        ...res.options,
        isRequired: false,
        isRequiredList: false
      });
    } else if (res.objectType && res.inputType) {
      objectDefinition[fieldName] = res.objectType.attribute(res.options);
      inputDefinition[fieldName] = res.inputType.attribute({
        ...res.options,
        isRequired: false,
        isRequiredList: false
      });
    }
  });
  return [
    new ObjectType(name, { definition: objectDefinition }),
    new InputType(`${name}Input`, { definition: inputDefinition })
  ];
};

const makeType = (
  item: AttributeValue,
  options: MakeTypeOptions
): MakeTypeResult => (isScalar(item) || isListOfScalars(item)) ?
  flatType(item, options) :
  complexType(item, options);

const flatType = (
  item: AttributeValue,
  options: MakeTypeOptions
): MakeTypeResult => {
  const attrType = firstKey(item);
  switch (attrType) {
    case "BOOL": return {
      options,
      scalarType: GraphqlType.boolean(options)
    };

    case "S": return {
      options,
      scalarType: isDateTime(item[attrType]!) ?
        GraphqlType.awsDateTime(options) :
        GraphqlType.string(options)
    };

    case "N": return {
      options,
      scalarType: /^[0-9]+$/ig.test(item[attrType]!) ?
        GraphqlType.int(options) :
        GraphqlType.float(options)
    };

    case "L":
      if (!isListOfScalars(item)) break;
      const innerItems = item[attrType]!;
      const innerItemsNotRequired = (innerItems as unknown[])
        .includes((it: unknown) => it === null || it === undefined);
      let firstInnerItem = innerItems[0];
      if (firstInnerItem === null || firstInnerItem === undefined) {
        const msg = "[W] Inner type is null or undefined: defaulting to string";
        console.log(msg);
        firstInnerItem = Converter.input("");
      }
      return flatType(firstInnerItem, {
        name: options.name,
        facet: options.facet,
        isList: true,
        isRequiredList: options.isRequired,
        isRequired: !innerItemsNotRequired
      });
  }

  throw new Error(`No scalar type constructor for ${JSON.stringify(item)}`);
};

const complexType = (
  item: AttributeValue,
  options: MakeTypeOptions
): MakeTypeResult => {
  const { facet, name } = options;
  const rootTypeName = `${singularize(capitalize(facet))}${capitalize(name)}`;
  if (firstKey(item) === "M") {
    const makeTypeResults: MakeTypeResults = Object
      .fromEntries(Object.entries(item.M!)
      .map(([name, val]) => [name, makeType(val, {
        ...options,
        name
      })]));
    const [objectType, inputType] = makeGraphqlTypes(
      rootTypeName,
      makeTypeResults
    );
    return {
      objectType,
      inputType,
      options
    };
  }
  throw new Error(`No object type for ${JSON.stringify(item)}`);
};

async function introspectFacet(
  tableName: string,
  facet: string
): Promise<PseudoGraphqlSchema> {
  const excludeKeys: Set<string> = new Set([
    "pk",
    "sk",
    "__facet",
    "__firestoreUpdatedAt",
    "__firestoreDocumentId"
  ]);
  const params = {
    TableName: tableName,
    IndexName: "facet-sk-index",
    ExpressionAttributeNames: {"#facet": "__facet"},
    ExpressionAttributeValues: {":val": Converter.input(facet)},
    KeyConditionExpression: "#facet = :val"
  };
  const res = await dynamodb.query(params).promise();
  const items = (res.Items ?? [] as AttributeMap[]);
  const prototypeItem = items.reduce((x, y) => ({...x, ...y}), {});
  const itemKeys = new Set(Object.keys(prototypeItem));
  const requiredKeys = items
    .map((it) => new Set(Object.keys(it).filter((k) => !excludeKeys.has(k))))
    .reduce((x, y) => setIntersect(x, y), itemKeys);
  const makeTypeResults: MakeTypeResults =
    Object.fromEntries(Object.entries(prototypeItem)
      .filter(([name, _]) => !excludeKeys.has(name))
      .map(([name, value]) => [name, makeType(value, {
        facet,
        name,
        isRequired: requiredKeys.has(name)
      })])
      .concat([["key", { scalarType: GraphqlType.id({ isRequired: true }) }]])
    );
  const name = singularize(capitalize(facet));
  const [rootType, inputType] = makeGraphqlTypes(name, makeTypeResults);
  const innerTypes = unwindIntermediateTypes(rootType) as ObjectType[];
  const innerInputs = unwindIntermediateTypes(inputType);
  return {
    rootTypes: [rootType as ObjectType, inputType],
    intermediateTypes: innerTypes.map((it, i) => [it, innerInputs[i]])
  };
}

export async function introspectGraphqlSchema(
  tableName: string
): Promise<PseudoGraphqlSchema[]> {
  try {
    const metaItem = await getMetaItem(tableName);
    const promises = metaItem.facets.values
      .sort()
      .map((facet: string) => introspectFacet(tableName, facet));
    return await Promise.all(promises);
  } catch (err) {
    return [];
  }
}

export const hydratePseudoSchema = (
  pseudoSchema: PseudoGraphqlSchema[]
): PseudoGraphqlSchema[] => {
  const makeDefinition = (source: GraphqlTypeDefinition) =>
    Object.fromEntries(Object.entries(source).map(([name, opts]) => {
      return [
        name,
        makeScalarType(opts.type, opts) ?? opts
      ];
  }));
  return pseudoSchema.map((it: PseudoGraphqlSchema) => {
    const [objectType, inputType] = it.rootTypes;
    return {
      rootTypes: [
        new ObjectType(objectType.name, {
          definition: makeDefinition(objectType.definition)
        }),
        new InputType(inputType.name, {
          definition: makeDefinition(inputType.definition)
        })
      ] as [ObjectType, InputType],
      intermediateTypes: it.intermediateTypes.map(([objectType, inputType]) => [
        new ObjectType(objectType.name, {
          definition: makeDefinition(objectType.definition)
        }),
        new InputType(inputType.name, {
          definition: makeDefinition(inputType.definition)
        })
      ]) as [ObjectType, InputType][]
    };
  });
};
