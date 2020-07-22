export type AnyObject = {[k: string]: any};

export const isObject = (obj: AnyObject): boolean =>
  typeof obj === "object" && obj !== null;

export const firstKey = (obj: AnyObject): string => Object.keys(obj).shift()!;

export function sortKeys(obj: AnyObject): AnyObject {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

export function flatten(obj: AnyObject, delimiter = "_D_"): AnyObject {
  const flatten_ = (child: AnyObject, path: string[] = []): AnyObject[] =>
    ([] as AnyObject[]).concat(...Object.entries(child)
      .map(([key, val]) => isObject(val) ?
        flatten_(val, path.concat([key])) :
        ({ [path.concat([key]).join(delimiter)]: val })
      )
    );
  return Object.assign({}, ...flatten_(obj));
}

export function unflatten(obj: AnyObject, delimiter = "_D_"): AnyObject {
  const out: AnyObject = {};
  Object.entries(obj).forEach(([key, val]) => {
    const unflatten_ = (child: AnyObject, path: string[] = []) => {
      const key = path.shift();
      if (!key) return;
      child[key] = path.length === 0 ? val : {...(child[key] ?? {})};
      unflatten_(child[key], path);
    };
    unflatten_(out, key.split(delimiter));
  });
  return out;
}
