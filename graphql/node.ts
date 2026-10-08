/** Translate the Drizzle node loader's missing-post error at the root only. */
export async function resolvePostNode<T>(
  id: string,
  model: unknown,
  load: () => T | PromiseLike<T>,
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    // Pothos Drizzle rejects missing rows, whereas Relay's nullable `node`
    // field must accommodate posts deleted after a client stored their IDs.
    // Match this exact loader error so database and nested resolver errors
    // retain their normal reporting behavior.
    if (
      model === "postTable" &&
      error instanceof Error &&
      error.constructor === Error &&
      error.message === `Model postTable(${id}) not found`
    ) {
      return null;
    }
    throw error;
  }
}
