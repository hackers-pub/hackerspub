import { builder } from "@hackerspub/federation";

builder.setWebFingerLinksDispatcher(async (ctx, _resource) => {
  return [
    {
      rel: "http://ostatus.org/schema/1.0/subscribe",
      template: `${ctx.origin}/authorize_interaction?uri={uri}`,
    },
  ];
});
