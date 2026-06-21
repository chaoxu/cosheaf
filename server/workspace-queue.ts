const workspaceQueues = new Map<string, Promise<void>>();

export async function serializeWorkspace<T>(slug: string, work: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(slug) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const current = run.then(() => undefined, () => undefined);
  workspaceQueues.set(slug, current);
  try {
    return await run;
  } finally {
    if (workspaceQueues.get(slug) === current) workspaceQueues.delete(slug);
  }
}
