const articleViewTokenStorageKey = "hackerspub.articleViewTokens";
const articleViewTokenLifetimeMilliseconds = 30 * 60 * 1000;

interface StoredArticleViewToken {
  readonly token: string;
  readonly expires: number;
}

type StoredArticleViewTokens = Record<string, StoredArticleViewToken>;

interface ArticleViewTokenOptions {
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly now?: number;
  readonly generateToken?: () => string;
}

function readTokens(
  storage: Pick<Storage, "getItem" | "setItem">,
): StoredArticleViewTokens {
  try {
    const value = storage.getItem(articleViewTokenStorageKey);
    if (value == null) return {};
    const parsed: unknown = JSON.parse(value);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const tokens: StoredArticleViewTokens = {};
    for (const [articleSourceId, candidate] of Object.entries(parsed)) {
      if (
        candidate != null &&
        typeof candidate === "object" &&
        "token" in candidate &&
        typeof candidate.token === "string" &&
        "expires" in candidate &&
        typeof candidate.expires === "number"
      ) {
        tokens[articleSourceId] = {
          token: candidate.token,
          expires: candidate.expires,
        };
      }
    }
    return tokens;
  } catch {
    return {};
  }
}

export function getArticleViewToken(
  articleSourceId: string,
  options: ArticleViewTokenOptions = {},
): string {
  const storage = options.storage ?? window.localStorage;
  const now = options.now ?? Date.now();
  const generateToken = options.generateToken ?? (() => crypto.randomUUID());
  const tokens = readTokens(storage);
  const existing = tokens[articleSourceId];
  if (existing != null && existing.expires > now) return existing.token;

  for (const [storedArticleSourceId, token] of Object.entries(tokens)) {
    if (token.expires <= now) delete tokens[storedArticleSourceId];
  }
  const token = generateToken();
  tokens[articleSourceId] = {
    token,
    expires: now + articleViewTokenLifetimeMilliseconds,
  };
  try {
    storage.setItem(articleViewTokenStorageKey, JSON.stringify(tokens));
  } catch {
    // Storage may be disabled or full. The in-memory token still lets this
    // page attempt one view; the server remains the deduplication authority.
  }
  return token;
}
