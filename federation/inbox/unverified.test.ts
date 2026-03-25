import type { RequestContext, UnverifiedActivityReason } from "@fedify/fedify";
import { Create, Delete } from "@fedify/vocab";
import { assertEquals } from "@std/assert/equals";
import type { ContextData } from "@hackerspub/models/context";
import {
  onUnverifiedActivity,
  shouldAcknowledgeUnverifiedActivity,
} from "./unverified.ts";

const requestContext = {} as RequestContext<ContextData>;

function keyFetchError(status: number): UnverifiedActivityReason {
  return {
    type: "keyFetchError",
    keyId: new URL("https://remote.example/actors/alice#main-key"),
    result: {
      status,
      response: new Response(null, { status }),
    },
  };
}

Deno.test("shouldAcknowledgeUnverifiedActivity()", async (t) => {
  await t.step(
    "acknowledges Delete activities for 410 key fetch failures",
    () => {
      const activity = new Delete({
        actor: new URL("https://remote.example/actors/alice"),
        object: new URL("https://remote.example/actors/alice"),
      });
      const reason = keyFetchError(410);

      assertEquals(shouldAcknowledgeUnverifiedActivity(activity, reason), true);
      assertEquals(
        onUnverifiedActivity(requestContext, activity, reason)?.status,
        202,
      );
    },
  );

  await t.step("does not acknowledge 404 key fetch failures", () => {
    const activity = new Delete({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/actors/alice"),
    });

    assertEquals(
      shouldAcknowledgeUnverifiedActivity(activity, keyFetchError(404)),
      false,
    );
    assertEquals(
      onUnverifiedActivity(requestContext, activity, keyFetchError(404)),
      undefined,
    );
  });

  await t.step("does not acknowledge non-Delete activities", () => {
    const activity = new Create({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/notes/1"),
    });

    assertEquals(
      shouldAcknowledgeUnverifiedActivity(activity, keyFetchError(410)),
      false,
    );
    assertEquals(
      onUnverifiedActivity(requestContext, activity, keyFetchError(410)),
      undefined,
    );
  });

  await t.step("does not acknowledge non-key-fetch failures", () => {
    const activity = new Delete({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/actors/alice"),
    });

    assertEquals(
      shouldAcknowledgeUnverifiedActivity(activity, { type: "noSignature" }),
      false,
    );
    assertEquals(
      shouldAcknowledgeUnverifiedActivity(activity, {
        type: "invalidSignature",
        keyId: new URL("https://remote.example/actors/alice#main-key"),
      }),
      false,
    );
  });
});
