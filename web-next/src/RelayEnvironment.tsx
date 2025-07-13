import type { FetchFunction, IEnvironment } from "relay-runtime";
import { Environment, Network, RecordSource, Store } from "relay-runtime";
import { getRequestEvent } from "solid-js/web";
import { getCookie } from "vinxi/http";

const fetchFn: FetchFunction = async (
  params,
  variables,
) => {
  "use server";

  if (!params.text) throw new Error("Operation document must be provided");

  const event = getRequestEvent();
  const sessionId = event == null
    ? null
    : getCookie(event.nativeEvent, "session");

  const response = await fetch(import.meta.env.VITE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...sessionId == null ? {} : {
        "Authorization": "Bearer " + sessionId,
      },
    },
    credentials: "include",
    body: JSON.stringify({ query: params.text, variables }),
  });

  return await response.json();
};

export function createEnvironment(): IEnvironment {
  const network = Network.create((params, variables, cacheConfig) => {
    return fetchFn(params, variables, cacheConfig);
  });
  const store = new Store(new RecordSource());
  return new Environment({ store, network });
}
