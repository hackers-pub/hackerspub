/* eslint-disable solid/no-innerhtml -- This file is the application's single reviewed HTML-rendering boundary. */
import { Polymorphic, type PolymorphicProps } from "@kobalte/core/polymorphic";
import { splitProps, type ValidComponent } from "solid-js";

interface HtmlContentOptions {
  /**
   * HTML that has already crossed an audited trust boundary, such as a
   * GraphQL `HTML` scalar, a locally generated SVG, or a compile-time script.
   * Never pass raw user input.
   */
  html: string | null | undefined;
  children?: never;
  innerHTML?: never;
}

export type HtmlContentProps<T extends ValidComponent = "div"> =
  PolymorphicProps<T, HtmlContentOptions>;

/** Centralizes the application's reviewed HTML-rendering boundary. */
export function HtmlContent<T extends ValidComponent = "div">(
  props: HtmlContentProps<T>,
) {
  const [local, others] = splitProps(props as HtmlContentProps, ["as", "html"]);
  return (
    <Polymorphic
      {...others}
      as={local.as ?? "div"}
      innerHTML={local.html ?? ""}
    />
  );
}
