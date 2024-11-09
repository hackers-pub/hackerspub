import { PageTitle } from "../components/PageTitle.tsx";
import { define } from "../utils.ts";

export default define.page(function Home() {
  return (
    <article>
      <PageTitle>What is Hackers' Pub?</PageTitle>
      <div class="prose prose-h2:text-xl dark:prose-invert">
        <p>
          Hackers' Pub is a place for hackers to share their knowledge and
          experience with each other. It's also an ActivityPub-enabled social
          network, so you can follow your favorite hackers in the fediverse and
          get their latest posts in your feed.
        </p>
        <h2>Features</h2>
        <p>Hackers' Pub has the following features:</p>
        <ul>
          <li>ActivityPub support</li>
          <li>Markdown support</li>
        </ul>
      </div>
    </article>
  );
});
