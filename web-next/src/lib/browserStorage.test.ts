import assert from "node:assert";
import test from "node:test";
import {
  type BrowserStorageHost,
  getBrowserLocalStorage,
  readBrowserLocalStorage,
  writeBrowserLocalStorage,
} from "./browserStorage.ts";

function hostWithStorage(storage: Partial<Storage>): BrowserStorageHost {
  return { localStorage: storage as Storage };
}

test("browser storage helpers tolerate a denied storage getter", () => {
  const host = Object.defineProperty({}, "localStorage", {
    get() {
      throw new DOMException("Access is denied", "SecurityError");
    },
  }) as BrowserStorageHost;

  assert.equal(getBrowserLocalStorage(host), undefined);
  assert.equal(readBrowserLocalStorage("key", host), null);
  assert.equal(writeBrowserLocalStorage("key", "value", host), false);
});

test("browser storage helpers tolerate denied storage operations", () => {
  const host = hostWithStorage({
    getItem() {
      throw new DOMException("Access is denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("Access is denied", "SecurityError");
    },
  });

  assert.equal(readBrowserLocalStorage("key", host), null);
  assert.equal(writeBrowserLocalStorage("key", "value", host), false);
});

test("browser storage helpers read and write available storage", () => {
  const values = new Map<string, string>();
  const host = hostWithStorage({
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  });

  assert.equal(writeBrowserLocalStorage("key", "value", host), true);
  assert.equal(readBrowserLocalStorage("key", host), "value");
});
