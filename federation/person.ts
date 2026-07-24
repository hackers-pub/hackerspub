import type { ActorKeyPair, Context } from "@fedify/fedify";
import { Endpoints, Image, Organization, Person } from "@fedify/vocab";
import { getAvatarUrl, renderAccountLinks } from "@hackerspub/models/account";
import type { ContextData } from "@hackerspub/models/context";
import { toApplicationContext } from "./context.ts";
import { removeHeaderAnchorLinks } from "@hackerspub/models/html";
import { renderMarkup } from "@hackerspub/models/markup";
import { isActorBanned } from "@hackerspub/models/moderation";
import type {
  Account,
  AccountEmail,
  AccountLink,
  Actor,
  Medium,
} from "@hackerspub/models/schema";

/**
 * Builds the ActivityPub actor for a local account.
 *
 * A permanently suspended (banned) account is served as a stub with
 * Mastodon's `suspended` flag set and the profile content (display name,
 * bio, avatar, profile links) emptied: the document stays fetchable so
 * HTTP signature keys remain resolvable and remote servers do not mistake
 * the suspension for a deletion, but no profile content is exposed.
 * A temporary suspension only restricts writing and is not signaled.
 */
export async function getAccountActor(
  ctx: Context<ContextData>,
  account: Account & {
    actor: Actor;
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  },
  keys: ActorKeyPair[],
): Promise<Organization | Person> {
  const identifier = account.id;
  const ActorClass = account.kind === "organization" ? Organization : Person;
  const common = {
    id: ctx.getActorUri(identifier),
    preferredUsername: account.username,
    manuallyApprovesFollowers: false,
    published: account.created.toTemporalInstant(),
    assertionMethods: keys.map((pair) => pair.multikey),
    publicKey: keys[0]?.cryptographicKey,
    inbox: ctx.getInboxUri(identifier),
    outbox: ctx.getOutboxUri(identifier),
    endpoints: new Endpoints({
      sharedInbox: ctx.getInboxUri(),
    }),
    following: ctx.getFollowingUri(identifier),
    followers: ctx.getFollowersUri(identifier),
    featured: ctx.getFeaturedUri(identifier),
    url: new URL(`/@${account.username}`, ctx.canonicalOrigin),
    aliases: account.actor.aliases.map((alias) => new URL(alias)),
  };
  if (isActorBanned(account.actor)) {
    return new ActorClass({
      ...common,
      suspended: true,
    });
  }
  const bio = await renderMarkup(toApplicationContext(ctx), account.bio, {
    docId: account.id,
    kv: ctx.data.kv,
  });
  return new ActorClass({
    ...common,
    name: account.name,
    summary: removeHeaderAnchorLinks(bio.html),
    icon: new Image({
      url: new URL(await getAvatarUrl(ctx.data.disk, account)),
    }),
    attachments: renderAccountLinks(account.links),
  });
}
