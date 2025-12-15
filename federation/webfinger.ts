import { builder } from "@hackerspub/federation";

builder.setWebFingerLinksDispatcher(async (_ctx, _resource) => {
  return [
    {
      rel: "http://ostatus.org/schema/1.0/subscribe",
      template: `https://hackers.pub/authorize_interaction?uri={uri}`,
    },
  ];
});
