import type { JSX, ParentComponent } from "solid-js";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
import { type SettingsTab, SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import type { SettingsTabs_account$key } from "./__generated__/SettingsTabs_account.graphql.ts";

export interface SettingsCardPageProps {
  $account: SettingsTabs_account$key;
  cardTitle: JSX.Element;
  description: JSX.Element;
  selected: SettingsTab;
  title: JSX.Element;
}

export const SettingsCardPage: ParentComponent<SettingsCardPageProps> = (
  props,
) => (
  <>
    <Title>{props.title}</Title>
    <SettingsContainer class="p-4">
      <SettingsTabs selected={props.selected} $account={props.$account} />
      <Card class="mt-4">
        <CardHeader>
          <CardTitle>{props.cardTitle}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
        </CardHeader>
        <CardContent>{props.children}</CardContent>
      </Card>
    </SettingsContainer>
  </>
);
