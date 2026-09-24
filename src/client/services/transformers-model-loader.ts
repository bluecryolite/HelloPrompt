export type TransformersEnvironment = {
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  localModelPath: string;
};

let modelLoadQueue: Promise<void> = Promise.resolve();

export function withTransformersLocalModelPath<T>(
  env: TransformersEnvironment,
  assetBaseUrl: string,
  load: () => Promise<T>,
): Promise<T> {
  const operation = modelLoadQueue.then(async () => {
    const previousModelPath = env.localModelPath;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = assetBaseUrl;
    try {
      return await load();
    } finally {
      env.localModelPath = previousModelPath;
    }
  });
  modelLoadQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
