import { type I18n, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/solid";
import { MemoryRouter, Route } from "@solidjs/router";
import { createJSXDecorator, type Preview } from "storybook-solidjs-vite";
import { ActingAccountProvider } from "../src/contexts/ActingAccountContext.tsx";
import { NoteComposeProvider } from "../src/contexts/NoteComposeContext.tsx";
import { ViewerProvider } from "../src/contexts/ViewerContext.tsx";
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

// Post components read `useNavigate()`/`<A>` (router), and reach into
// `ViewerContext` / `ActingAccountContext` / `NoteComposeContext` for the
// signed-in viewer, the active posting identity, and the compose modal.
// None of that is exercised by clicking through a static story, so a
// single set of inert defaults covers every story that needs it.
const withProviders = createJSXDecorator((Story) => (
  <MemoryRouter
    root={() => (
      <ViewerProvider isAuthenticated={() => false} isLoaded={() => true}>
        <ActingAccountProvider>
          <NoteComposeProvider>
            <Story />
          </NoteComposeProvider>
        </ActingAccountProvider>
      </ViewerProvider>
    )}
  >
    <Route path="*" component={() => null} />
  </MemoryRouter>
));

const preview: Preview = {
  loaders: [async () => ({ i18n: await loadStorybookI18n() })],
  decorators: [withI18n, withProviders],
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
