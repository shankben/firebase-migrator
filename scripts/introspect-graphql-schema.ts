import { getMetaItem, introspectGraphqlSchema } from "../lib/utils";

async function main() {
  const metaItem = await getMetaItem(process.env.TABLE_NAME!);
  const pseudoSchema = await introspectGraphqlSchema(process.env.TABLE_NAME!);
  console.dir(pseudoSchema, { depth: null });
}

main().catch(console.error);
