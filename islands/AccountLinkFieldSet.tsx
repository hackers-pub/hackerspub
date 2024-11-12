import { useState } from "preact/hooks";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";

export interface AccountLinkFieldSetProps {
  links: AccountLinkFieldProps[];
}

export function AccountLinkFieldSet(props: AccountLinkFieldSetProps) {
  const [links, setLinks] = useState([...props.links]);
  return (
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
    <div class="grid lg:grid-cols-2 gap-5">
      <div>
        <Label label="Link name" required={props.required}>
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
            A name for the link that will be displayed on your profile, e.g.,
            {" "}
            <q>GitHub</q>.
          </p>
        )}
      </div>
      <div>
        <Label label="URL" required={props.required}>
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
            The URL of the link, e.g., <q>https://github.com/yourhandle</q>.
          </p>
        )}
      </div>
    </div>
  );
}
