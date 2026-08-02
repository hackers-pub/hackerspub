import type { Preview } from "storybook-solidjs-vite";
import { createJSXDecorator } from "storybook-solidjs-vite";
import "../src/app.css";
import { I18nDecorator } from "./decorators/i18n-decorator.tsx";

// Components read translations through `useLingui`, which throws without
// a Lingui provider, so every story gets one globally.  The plain
// `(Story) => JSX` decorator form silently renders nothing with the
// Solid renderer; it must be tagged via `createJSXDecorator`.
const withI18n = createJSXDecorator((Story) => (
  <I18nDecorator locale="en-US">
    <Story />
  </I18nDecorator>
));

const preview: Preview = {
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
