import { type I18n, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/solid";
import { createJSXDecorator, type Preview } from "storybook-solidjs-vite";
import "../src/app.css";

let storybookI18n: I18n | undefined;

async function loadStorybookI18n(): Promise<I18n> {
  if (storybookI18n) return storybookI18n;
  const { messages } = await import("../src/locales/en-US/messages.po");
  storybookI18n = setupI18n({
    locale: "en-US",
    locales: ["en-US"],
    messages: { "en-US": messages },
  });
  return storybookI18n;
}

// Stories use the `useLingui()` macro, which requires a Lingui
// `I18nProvider` ancestor. A `loader` resolves the catalog before the
// story renders (Solid's reactivity can't survive the async gap inside a
// decorator), so the decorator itself can stay synchronous.
const withI18n = createJSXDecorator((Story, context) => (
  <I18nProvider i18n={context.loaded.i18n as I18n}>
    <Story />
  </I18nProvider>
));

const preview: Preview = {
  loaders: [async () => ({ i18n: await loadStorybookI18n() })],
  decorators: [withI18n],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
