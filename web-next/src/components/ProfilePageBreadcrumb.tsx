import { graphql } from "relay-runtime";
import type { Component, ParentComponent } from "solid-js";
import {
  ComponentProps,
  createContext,
  createRenderEffect,
  createSignal,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { createFragment } from "solid-relay";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { ProfilePageBreadcrumb_actor$key } from "./__generated__/ProfilePageBreadcrumb_actor.graphql.ts";
import { TopBreadcrumb } from "./TopBreadcrumb.tsx";

export interface ProfilePageBreadcrumbProps extends ComponentProps<"ol"> {
  $actor: ProfilePageBreadcrumb_actor$key;
}

export function ProfilePageBreadcrumb(props: ProfilePageBreadcrumbProps) {
  const { breadcrumb } = useProfilePageBreadcrumb();
  const actor = createFragment(
    graphql`
      fragment ProfilePageBreadcrumb_actor on Actor {
        name
        username
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(actor) => (
        <TopBreadcrumb>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink
              current={breadcrumb() == null}
              href={breadcrumb() == null ? undefined : `/@${actor().username}`}
            >
              <span innerHTML={actor().name ?? actor().username} />
            </BreadcrumbLink>
          </BreadcrumbItem>
          <Show when={breadcrumb()}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink current>
                {breadcrumb()}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Show>
        </TopBreadcrumb>
      )}
    </Show>
  );
}

type ProfilePageBreadcrumbContextType = {
  breadcrumb: () => string | undefined;
  setBreadcrumb: (breadcrumb: string | undefined) => void;
};

const ProfilePageBreadcrumbContext = createContext<
  ProfilePageBreadcrumbContextType
>();

export const ProfilePageBreadcrumbProvider: ParentComponent = (props) => {
  const [breadcrumb, setBreadcrumb] = createSignal<string | undefined>();

  const value: ProfilePageBreadcrumbContextType = {
    breadcrumb,
    setBreadcrumb,
  };

  return (
    <ProfilePageBreadcrumbContext.Provider value={value}>
      {props.children}
    </ProfilePageBreadcrumbContext.Provider>
  );
};

const useProfilePageBreadcrumb = () => {
  const context = useContext(ProfilePageBreadcrumbContext);
  if (!context) {
    throw new Error(
      "useProfilePageBreadcrumb must be used within a ProfilePageBreadcrumbProvider",
    );
  }
  return context;
};

interface ProfilePageBreadcrumbItemProps {
  breadcrumb: string | undefined;
}

export const ProfilePageBreadcrumbItem: Component<
  ProfilePageBreadcrumbItemProps
> = (props) => {
  const { setBreadcrumb } = useProfilePageBreadcrumb();
  createRenderEffect(() => setBreadcrumb(props.breadcrumb));
  onCleanup(() => setBreadcrumb(undefined));
  return null;
};
