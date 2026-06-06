import type { RequestContext, UnverifiedActivityReason } from "@fedify/fedify";
import { Create, Delete } from "@fedify/vocab";
import assert from "node:assert";
import { describe, it } from "node:test";
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

describe("shouldAcknowledgeUnverifiedActivity()", () => {
  it(
    "acknowledges Delete activities for 410 key fetch failures",
    () => {
      const activity = new Delete({
        actor: new URL("https://remote.example/actors/alice"),
        object: new URL("https://remote.example/actors/alice"),
      });
      const reason = keyFetchError(410);

      assert.deepEqual(
        shouldAcknowledgeUnverifiedActivity(activity, reason),
        true,
      );
      assert.deepEqual(
        onUnverifiedActivity(requestContext, activity, reason)?.status,
        202,
      );
    },
  );

  it("does not acknowledge 404 key fetch failures", () => {
    const activity = new Delete({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/actors/alice"),
    });

    assert.deepEqual(
      shouldAcknowledgeUnverifiedActivity(activity, keyFetchError(404)),
      false,
    );
    assert.deepEqual(
      onUnverifiedActivity(requestContext, activity, keyFetchError(404)),
      undefined,
    );
  });

  it("does not acknowledge non-Delete activities", () => {
    const activity = new Create({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/notes/1"),
    });

    assert.deepEqual(
      shouldAcknowledgeUnverifiedActivity(activity, keyFetchError(410)),
      false,
    );
    assert.deepEqual(
      onUnverifiedActivity(requestContext, activity, keyFetchError(410)),
      undefined,
    );
  });

  it("does not acknowledge non-key-fetch failures", () => {
    const activity = new Delete({
      actor: new URL("https://remote.example/actors/alice"),
      object: new URL("https://remote.example/actors/alice"),
    });

    assert.deepEqual(
      shouldAcknowledgeUnverifiedActivity(activity, { type: "noSignature" }),
      false,
    );
    assert.deepEqual(
      shouldAcknowledgeUnverifiedActivity(activity, {
        type: "invalidSignature",
        keyId: new URL("https://remote.example/actors/alice#main-key"),
      }),
      false,
    );
  });
});
