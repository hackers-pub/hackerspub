import { Navigate, useLocation } from "@solidjs/router";
import { Match, type ParentComponent, Switch } from "solid-js";

export interface SettingsOwnerGuardProps {
  accountId?: string | null;
  canManageSettings?: boolean | null;
  viewerId?: string | null;
}

export const SettingsOwnerGuard: ParentComponent<SettingsOwnerGuardProps> = (
  props,
) => {
  const location = useLocation();
  const canManage = () =>
    props.canManageSettings ??
      (props.accountId != null && props.viewerId === props.accountId);

  return (
    <Switch>
      <Match when={props.viewerId == null}>
        <Navigate
          href={`/sign?next=${encodeURIComponent(location.pathname)}`}
        />
      </Match>
      <Match when={props.accountId != null && !canManage()}>
        <Navigate href="/" />
      </Match>
      <Match when={props.accountId != null}>
        {props.children}
      </Match>
    </Switch>
  );
};
