import { JSX } from "preact";

export type ConfirmFormProps =
  & Omit<JSX.HTMLAttributes<HTMLFormElement>, "onSubmit">
  & { confirm: string };

export function ConfirmForm(props: ConfirmFormProps) {
  const attrs: Omit<ConfirmFormProps, "confirm"> & { confirm?: string } = {
    ...props,
  };
  delete attrs.confirm;
  delete attrs.children;
  return (
    <form
      {...attrs}
      onSubmit={(event) => confirm(props.confirm) || event.preventDefault()}
    >
      {props.children}
    </form>
  );
}
