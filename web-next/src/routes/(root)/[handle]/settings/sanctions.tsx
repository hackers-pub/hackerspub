import {
  Navigate,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

export default function SanctionsRedirectPage() {
  const location = useLocation();
  const params = useParams();
  return (
    <Navigate
      href={`/${decodeRouteParam(
        params.handle!,
      )}/settings/moderation${location.search}${location.hash}`}
    />
  );
}
