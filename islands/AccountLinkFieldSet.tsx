import { useState } from "preact/hooks";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";
import { Msg, Translation, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";

export interface AccountLinkFieldSetProps {
  links: AccountLinkFieldProps[];
  language: Language;
}

export function AccountLinkFieldSet(props: AccountLinkFieldSetProps) {
  const [links, setLinks] = useState([...props.links]);
  return (
    <TranslationSetup language={props.language}>
      <div class="flex flex-col gap-5">
        {links.map((link, i) => (
          <AccountLinkField
            key={i}
            name={link.name}
            url={link.url}
            onChanged={(link) =>
              !(link.name?.length || link.url?.toString()?.length) &&
              setLinks(links.filter((_, j) => j !== i))}
            required={true}
            showHelp={i == 0 || link.url == null || link.url === ""}
          />
        ))}
        <AccountLinkField
          key={links.length}
          onChanged={(link) =>
            (link.name?.length || link.url?.toString()?.length) &&
            setLinks([...links, link])}
          required={false}
          showHelp={true}
        />
      </div>
    </TranslationSetup>
  );
}

export interface AccountLinkFieldProps {
  name?: string;
  url?: URL | string;
  onChanged?: (link: AccountLinkFieldProps) => void;
  required?: boolean;
  showHelp?: boolean;
}

export function AccountLinkField(props: AccountLinkFieldProps) {
  return (
    <Translation>
      {(t) => (
        <div class="grid lg:grid-cols-2 gap-5">
          <div>
            <Label
              label={t("settings.profile.linkName")}
              required={props.required}
            >
              <Input
                type="text"
                name="link-name"
                class="w-full"
                pattern="^.{0,50}$"
                onChange={(e) =>
                  props.onChanged?.({
                    ...props,
                    name: (e.target as HTMLInputElement).value,
                  })}
                value={props.name}
                required={props.required}
              />
            </Label>
            {props.showHelp && (
              <p class="opacity-50">
                <Msg $key="settings.profile.linkNameDescription" />
              </p>
            )}
          </div>
          <div>
            <Label
              label={t("settings.profile.url")}
              required={props.required}
            >
              <Input
                type="url"
                name="link-url"
                class="w-full"
                onChange={(e) =>
                  props.onChanged?.({
                    ...props,
                    url: (e.target as HTMLInputElement).value,
                  })}
                value={props.url?.toString()}
                required={props.required}
              />
            </Label>
            {props.showHelp && (
              <p class="opacity-50">
                <Msg $key="settings.profile.urlDescription" />
              </p>
            )}
          </div>
        </div>
      )}
    </Translation>
  );
}
