import type { FetchFunction, IEnvironment } from "relay-runtime";
import { Environment, Network, RecordSource, Store } from "relay-runtime";

const fetchFn: FetchFunction = async (
  params,
  variables,
) => {
  if (!params.text) throw new Error("Operation document must be provided");

  const response = await fetch(import.meta.env.VITE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ query: params.text, variables }),
  });

  return await response.json();
};

export function createEnvironment(): IEnvironment {
  const network = Network.create((...args) => {
    return fetchFn(...args);
  });
  const store = new Store(new RecordSource());
  return new Environment({ store, network });
}
