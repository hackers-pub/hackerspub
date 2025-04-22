import { define } from "../../utils.ts";

export const handler = define.middleware([
  (ctx) => {
    if (ctx.state.account?.moderator) return ctx.next();
    return ctx.redirect("/sign");
  },
]);
