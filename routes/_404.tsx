import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import getFixedT from "../i18n.ts";
import { define } from "../utils.ts";

export const handler = define.handlers((ctx) => {
  if (ctx.state.t == null) {
    // FIXME: _middleware.ts seems ignored when _404.tsx is requested,
    // and I guess it's a bug of Fresh v2.0.0-alpha.29?  I hope it's fixed
    // in the future...
    // See also https://github.com/denoland/fresh/issues/2843
    ctx.state.t = getFixedT("en");
    ctx.state.metas = [];
    ctx.state.links = [];
  }
  ctx.state.title = ctx.state.t("pageNotFound.title");
  return page();
});

export default define.page(function NotFound() {
  return (
    <>
      <PageTitle>
        <Msg $key="pageNotFound.title" />
      </PageTitle>
      <p>
        <Msg $key="pageNotFound.description" />
      </p>
    </>
  );
});
