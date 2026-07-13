import type { Context } from "@fedify/fedify";
import type {
  ApplicationContext,
  ContextData,
} from "@hackerspub/models/context";

/** Return the adapter-owned Fedify context for a federation implementation. */
export function getFedifyContext(
  context: ApplicationContext,
): Context<ContextData> {
  const fedifyContext = context.federation;
  if (
    typeof fedifyContext !== "object" || fedifyContext == null ||
    !("data" in fedifyContext)
  ) {
    throw new TypeError(
      "Application context was not created by Fedify adapter",
    );
  }
  const raw = fedifyContext as Context<ContextData>;
  const cloned = raw.clone({
    ...raw.data,
    db: context.db,
    rootDb: context.rootDb,
    afterCommit: context.afterCommit,
  });
  return Object.assign(cloned, {
    documentLoader: context.documentLoader,
    contextLoader: context.contextLoader,
    getActorUri: context.getActorUri,
    getInboxUri: context.getInboxUri,
    getOutboxUri: context.getOutboxUri,
    getFollowersUri: context.getFollowersUri,
    getFollowingUri: context.getFollowingUri,
    getFeaturedUri: context.getFeaturedUri,
    getObjectUri: context.getObjectUri,
    getDocumentLoader: context.getDocumentLoader,
    lookupObject: context.lookupObject,
    lookupWebFinger: context.lookupWebFinger,
    sendActivity: context.sendActivity,
  });
}

/** Translate a Fedify adapter context into the context used by application code. */
export function toApplicationContext(
  context: Context<ContextData>,
): ApplicationContext {
  const getActorKeyPairs = "getActorKeyPairs" in context &&
      typeof context.getActorKeyPairs === "function"
    ? (identifier: string) => context.getActorKeyPairs(identifier)
    : undefined;
  const applicationContext: ApplicationContext = {
    db: context.data.db,
    withDatabase(db) {
      return toApplicationContext(context.clone({
        ...context.data,
        db,
        rootDb: this.rootDb,
        afterCommit: this.afterCommit,
      }));
    },
    rootDb: context.data.rootDb,
    afterCommit: context.data.afterCommit,
    kv: context.data.kv,
    storage: context.data.disk,
    models: context.data.models,
    services: context.data.services,
    federation: context,
    origin: context.origin,
    canonicalOrigin: context.canonicalOrigin,
    host: context.host,
    documentLoader: context.documentLoader,
    contextLoader: context.contextLoader,
    getActorUri: context.getActorUri.bind(context),
    getInboxUri: context.getInboxUri.bind(context),
    getOutboxUri: context.getOutboxUri.bind(context),
    getFollowersUri: context.getFollowersUri.bind(context),
    getFollowingUri: context.getFollowingUri.bind(context),
    getFeaturedUri: context.getFeaturedUri.bind(context),
    getObjectUri: (type, values) => context.getObjectUri(type as never, values),
    getDocumentLoader: (options) =>
      context.getDocumentLoader(
        options as Parameters<typeof context.getDocumentLoader>[0],
      ),
    lookupObject: (value, options) =>
      context.lookupObject(
        value,
        options as Parameters<typeof context.lookupObject>[1],
      ),
    lookupWebFinger: (resource) => context.lookupWebFinger(resource),
    getActor: (identifier) => {
      if (
        "getActor" in context && typeof context.getActor === "function"
      ) {
        return context.getActor(identifier);
      }
      return Promise.resolve(null);
    },
    ...(getActorKeyPairs == null ? {} : { getActorKeyPairs }),
    sendActivity: (sender, recipients, activity, options) =>
      context.sendActivity(
        sender as never,
        recipients as never,
        activity,
        options as never,
      ),
  };
  return applicationContext;
}
