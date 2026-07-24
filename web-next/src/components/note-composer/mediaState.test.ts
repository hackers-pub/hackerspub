import assert from "node:assert";
import test from "node:test";
import { type MediaItem, reduceMediaItems } from "./mediaState.ts";

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    localId: "local",
    previewUrl: "blob:preview",
    alt: "",
    uploading: true,
    uploadProgress: 0,
    generatingAlt: false,
    ...overrides,
  };
}

test("reduceMediaItems tracks upload progress and completion", () => {
  let state: readonly MediaItem[] = [item()];
  state = reduceMediaItems(state, {
    type: "upload-progress",
    localId: "local",
    progress: 42,
  });
  assert.equal(state[0].uploadProgress, 42);

  state = reduceMediaItems(state, {
    type: "upload-completed",
    localId: "local",
    result: {
      uuid: "00000000-0000-0000-0000-000000000000",
      mediumRelayId: "relay-medium",
      url: "https://example.com/media.webp",
      width: 100,
      height: 50,
    },
  });
  assert.deepEqual(state[0], {
    ...item(),
    uploading: false,
    uploadProgress: 100,
    uuid: "00000000-0000-0000-0000-000000000000",
    mediumRelayId: "relay-medium",
    url: "https://example.com/media.webp",
    width: 100,
    height: 50,
    abortUpload: undefined,
  });
});

test("removed media ignores late asynchronous results", () => {
  let state: readonly MediaItem[] = reduceMediaItems([item()], {
    type: "remove",
    localId: "local",
  });
  state = reduceMediaItems(state, {
    type: "upload-completed",
    localId: "local",
    result: {
      uuid: "00000000-0000-0000-0000-000000000000",
      mediumRelayId: "relay-medium",
      url: "https://example.com/media.webp",
    },
  });
  assert.deepEqual(state, []);
});

test("alt generation preserves existing text when no replacement is returned", () => {
  let state: readonly MediaItem[] = [item({ alt: "Existing" })];
  state = reduceMediaItems(state, {
    type: "alt-started",
    localId: "local",
  });
  assert.equal(state[0].generatingAlt, true);

  state = reduceMediaItems(state, {
    type: "alt-completed",
    localId: "local",
    alt: null,
  });
  assert.equal(state[0].generatingAlt, false);
  assert.equal(state[0].alt, "Existing");
});

test("alt cancellation clears only the pending state", () => {
  const subscription = { unsubscribe() {} };
  const state = reduceMediaItems(
    [
      item({
        alt: "Existing",
        generatingAlt: true,
        altSubscription: subscription,
      }),
    ],
    {
      type: "alt-cancelled",
      localId: "local",
    },
  );
  assert.equal(state[0].alt, "Existing");
  assert.equal(state[0].generatingAlt, false);
  assert.equal(state[0].altSubscription, undefined);
});
