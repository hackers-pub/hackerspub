export interface BrowserStorageHost {
  readonly localStorage?: Storage;
}

export function getBrowserLocalStorage(
  host: BrowserStorageHost = globalThis,
): Storage | undefined {
  try {
    return host.localStorage;
  } catch {
    return undefined;
  }
}

export function readBrowserLocalStorage(
  key: string,
  host: BrowserStorageHost = globalThis,
): string | null {
  try {
    return getBrowserLocalStorage(host)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserLocalStorage(
  key: string,
  value: string,
  host: BrowserStorageHost = globalThis,
): boolean {
  try {
    const storage = getBrowserLocalStorage(host);
    if (storage == null) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
