import assert from "node:assert";
import test from "node:test";
import { Article, Create, Hashtag, Update } from "@fedify/vocab";
import { relaySubscriptionTable } from "@hackerspub/models/schema";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";
import { sendArticleRelayActivity } from "./article-relay.ts";
import { getFedifyContext } from "./context.ts";

test("article relay sends accepted public Creates once per inbox", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articlerelayauthor",
      name: "Article Relay Author",
      email: "articlerelayauthor@example.com",
    });
    const tagsRelay = await insertRemoteActor(tx, {
      username: "tags",
      name: "Tags Relay",
      host: "tags.example",
      iri: "https://tags.example/actor",
      inboxUrl: "https://tags.example/inbox",
      type: "Application",
    });
    const acceptedRelay = await insertRemoteActor(tx, {
      username: "accepted",
      name: "Accepted Relay",
      host: "accepted-relay.example",
      inboxUrl: "https://accepted-relay.example/inbox",
      type: "Application",
    });
    const pendingRelay = await insertRemoteActor(tx, {
      username: "pending",
      name: "Pending Relay",
      host: "pending-relay.example",
      inboxUrl: "https://pending-relay.example/inbox",
      type: "Application",
    });
    const accepted = new Date("2026-08-27T00:00:00.000Z");
    await tx.insert(relaySubscriptionTable).values([
      {
        id: crypto.randomUUID(),
        actorId: tagsRelay.id,
        followIri: "http://localhost/relay-follow/tags",
        accepted,
      },
      {
        id: crypto.randomUUID(),
        actorId: acceptedRelay.id,
        followIri: "http://localhost/relay-follow/accepted",
        accepted,
      },
      {
        id: crypto.randomUUID(),
        actorId: pendingRelay.id,
        followIri: "http://localhost/relay-follow/pending",
      },
    ]);

    const article = new Article({
      id: new URL("http://localhost/articles/relay-test"),
      to: new URL("https://www.w3.org/ns/activitystreams#Public"),
      tags: [
        new Hashtag({
          name: "#analytics",
          href: new URL("http://localhost/tags/analytics"),
        }),
      ],
    });
    const create = new Create({
      id: new URL("http://localhost/articles/relay-test#create"),
      actor: new URL(`http://localhost/actors/${author.account.id}`),
      object: article,
    });
    const context = getFedifyContext(createFedCtx(tx));
    const sends: unknown[][] = [];
    context.sendActivity = (...args: unknown[]) => {
      sends.push(args);
      return Promise.resolve();
    };
    const relayedTags = await sendArticleRelayActivity(
      context,
      author.account.id,
      create,
      {
        orderingKey: article.id!.href,
        visibility: "public",
        accountBio: "",
      },
      {
        enabled: true,
        actorId: new URL(tagsRelay.iri),
        inboxId: new URL(tagsRelay.inboxUrl),
      },
    );

    assert.deepEqual(relayedTags, ["analytics"]);
    assert.equal(sends.length, 1);
    const recipients = sends[0][1] as Array<{ inboxId: URL }>;
    assert.deepEqual(
      recipients.map((recipient) => recipient.inboxId.href).sort(),
      ["https://accepted-relay.example/inbox", "https://tags.example/inbox"],
    );
    const sendOptions = sends[0][3] as {
      orderingKey: string;
      preferSharedInbox: boolean;
      excludeBaseUris: URL[];
      fanout: string;
    };
    assert.deepStrictEqual(
      {
        orderingKey: sendOptions.orderingKey,
        preferSharedInbox: sendOptions.preferSharedInbox,
        excludeBaseUris: sendOptions.excludeBaseUris.map((url) => url.href),
        fanout: sendOptions.fanout,
      },
      {
        orderingKey: article.id!.href,
        preferSharedInbox: false,
        excludeBaseUris: [
          new URL(context.origin).href,
          new URL(context.canonicalOrigin).href,
        ],
        fanout: "skip",
      },
    );

    assert.equal(
      await sendArticleRelayActivity(
        context,
        author.account.id,
        create,
        {
          orderingKey: article.id!.href,
          visibility: "public",
          accountBio: "",
        },
        { enabled: false },
      ),
      undefined,
    );
    const genericRecipients = sends[1][1] as Array<{ inboxId: URL }>;
    assert.deepStrictEqual(
      genericRecipients.map((recipient) => recipient.inboxId.href).sort(),
      ["https://accepted-relay.example/inbox", "https://tags.example/inbox"],
    );

    assert.equal(
      await sendArticleRelayActivity(
        context,
        author.account.id,
        create,
        {
          orderingKey: article.id!.href,
          visibility: "direct",
          accountBio: "",
        },
        {
          enabled: true,
          actorId: new URL(tagsRelay.iri),
          inboxId: new URL(tagsRelay.inboxUrl),
        },
      ),
      undefined,
    );
    const update = new Update({
      id: new URL("http://localhost/articles/relay-test#update"),
      actor: create.actorId,
      object: article,
    });
    assert.equal(
      await sendArticleRelayActivity(
        context,
        author.account.id,
        update,
        {
          orderingKey: article.id!.href,
          visibility: "public",
          accountBio: "",
        },
        { enabled: false },
      ),
      undefined,
    );
    assert.equal(sends.length, 2);
  });
});
