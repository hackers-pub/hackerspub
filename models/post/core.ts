import * as vocab from "@fedify/vocab";
import { sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import type {
  Account,
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Poll,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "../schema.ts";
import type { Uuid } from "../uuid.ts";

export type PostObject = vocab.Article | vocab.Note | vocab.Question;
export function isPostObject(object: unknown): object is PostObject {
  return object instanceof vocab.Article || object instanceof vocab.Note ||
    object instanceof vocab.Question;
}

export function isArticleLike(
  post: Post & { actor: Actor & { instance: Instance } },
): boolean {
  if (post.type === "Question") return false;
  return post.type === "Article" ||
    post.name != null && post.actor.instance.software !== "nodebb";
}

export function getPersistedPost(
  db: Database,
  iri: URL,
): Promise<
  | Post & {
    actor: Actor & { instance: Instance };
    mentions: (Mention & { actor: Actor })[];
    replyTarget: Post & { actor: Actor } | null;
    quotedPost: Post & { actor: Actor } | null;
    poll: Poll | null;
  }
  | undefined
> {
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: { instance: true },
      },
      mentions: {
        with: { actor: true },
      },
      replyTarget: {
        with: { actor: true },
      },
      quotedPost: {
        with: { actor: true },
      },
      poll: true,
    },
    where: {
      iri: iri.href,
    },
  });
}

export function getPostByUsernameAndId(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount: Account & { actor: Actor } | undefined,
): Promise<
  | Post & {
    actor: Actor & {
      instance: Instance;
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        link: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & {
              instance: Instance;
              followers: (Following & { follower: Actor })[];
              blockees: Blocking[];
              blockers: Blocking[];
            };
            link: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
        reactions: Reaction[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: (Following & { follower: Actor })[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        link: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  }
  | undefined
> {
  if (!username.includes("@")) return Promise.resolve(undefined);
  let host: string;
  [username, host] = username.split("@");
  return db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          instance: true,
          followers: true,
          blockees: true,
          blockers: true,
        },
      },
      link: { with: { creator: true } },
      sharedPost: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { followerId: signedAccount.actor.id },
              },
              blockees: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockeeId: signedAccount.actor.id },
              },
              blockers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockerId: signedAccount.actor.id },
              },
            },
          },
          link: { with: { creator: true } },
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                    with: { follower: true },
                  },
                  blockees: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockeeId: signedAccount.actor.id },
                  },
                  blockers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockerId: signedAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              mentions: {
                with: { actor: true },
              },
              media: true,
            },
          },
          mentions: {
            with: { actor: true },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
        },
      },
      replyTarget: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { followerId: signedAccount.actor.id },
                with: { follower: true },
              },
              blockees: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockeeId: signedAccount.actor.id },
              },
              blockers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockerId: signedAccount.actor.id },
              },
            },
          },
          link: { with: { creator: true } },
          mentions: {
            with: { actor: true },
          },
          media: true,
        },
      },
      mentions: {
        with: { actor: true },
      },
      media: true,
      shares: {
        where: signedAccount == null
          ? { RAW: sql`false` }
          : { actorId: signedAccount.actor.id },
      },
      reactions: {
        where: signedAccount == null
          ? { RAW: sql`false` }
          : { actorId: signedAccount.actor.id },
      },
    },
    where: {
      id,
      actor: {
        username,
        OR: [
          { instanceHost: host },
          { handleHost: host },
        ],
      },
    },
  });
}
