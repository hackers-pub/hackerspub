<!-- deno-fmt-ignore-file -->

Contribution guide
==================

We welcome contributions to the project. Please read the following guide to
learn how to contribute.


AI usage policy
---------------

If you use AI tools to contribute to Hackers' Pub, read the [AI usage policy]
before opening an issue, discussion, pull request, or commit.  AI assistance
must be disclosed in pull request descriptions and commit messages, and
AI-assisted pull requests must be tied to accepted issues or maintainer-approved
work items.

[AI usage policy]: ./AI_POLICY.md


Recommended reading
-------------------

Hackers' Pub uses the following technologies:

 -  [Node.js] for TypeScript tooling, tests, the web frontend, and the
    candidate GraphQL API runtime
 -  [Deno] for the federation worker and the GraphQL API rollback runtime
    during the Node.js migration
 -  [PostgreSQL] for the database
 -  [Drizzle ORM] for database operations
 -  [Keyv] for caching
 -  [Fedify] for ActivityPub federation
 -  [Pothos] for GraphQL schema builder
 -  [Yoga] for GraphQL server
 -  [LogTape] for logging
 -  [SolidStart] and [Solid] for the web frontend
 -  [Relay] for GraphQL data loading
 -  [Tailwind CSS] for styling
 -  [Vercel AI SDK] for LLM integration
 -  [Lingui] for internationalization
 -  [ffmpeg] for video processing

If you are not familiar with these technologies, we recommend reading the
documentation of these technologies to understand how they work.

For the visual side of the product — color tokens, typography, component
patterns, the *Pubnyan* mascot, and brand asset usage — read
[*DESIGN.md*](./DESIGN.md) before working on UI in *web-next/*.

[Node.js]: https://nodejs.org/
[Deno]: https://deno.com/
[PostgreSQL]: https://www.postgresql.org/
[Drizzle ORM]: https://orm.drizzle.team/
[Keyv]: https://keyv.org/
[Fedify]: https://fedify.dev/
[Pothos]: https://pothos-graphql.dev/
[Yoga]: https://www.graphql-yoga.com/
[LogTape]: https://logtape.org/
[SolidStart]: https://start.solidjs.com/
[Solid]: https://www.solidjs.com/
[Relay]: https://relay.dev/
[Tailwind CSS]: https://tailwindcss.com/
[Vercel AI SDK]: https://ai-sdk.dev/
[Lingui]: https://lingui.dev/
[ffmpeg]: https://ffmpeg.org/


Prerequisites
-------------

To build the project, you need to have the following tools installed:

 -  [mise]
 -  [PostgreSQL] 17 or higher
 -  [Redis]
 -  [ffmpeg] 5.0 or higher
 -  [Mailgun] account (optional; for sending emails)
 -  [Anthropic] API key (optional; for translating posts)
 -  [Google Generative AI] API key (optional; for summarizing posts)

Project tools and dependencies are managed by mise.  From the repository root,
run:

~~~~ sh
mise install
~~~~

This installs the pinned Deno, Node.js, pnpm, and project tools, installs Deno
and pnpm dependencies, and writes the pre-commit hook.

[mise]: https://mise.jdx.dev/
[Redis]: https://redis.io/docs/latest/operate/oss_and_stack/install/
[Mailgun]: https://www.mailgun.com/
[Anthropic]: https://console.anthropic.com/
[Google Generative AI]: https://aistudio.google.com/apikey


Creating a database
-------------------

To create a database, execute the following command:

~~~~ sh
createdb -E utf8 -T postgres hackerspub
~~~~

This command creates a database named `hackerspub`.  You can use a different
name if you want.


Configuration
-------------

The project uses environment variables for configuration. You can see the list
of all available variables in the *.env.sample* file.  Copy this file to *.env*
and set the values of the variables according to your environment.

> [!TIP]
> Here are some tips for setting up the environment variables for your local
> development:
>
>  -  Even if you are setting up a local development environment, you should
>     set `ORIGIN` to the URL where the server will be hosted, which is
>     accessible from the public internet.  This is required for the ActivityPub
>     federation to work.  See also the section on [*Setting up
>     federation*](#setting-up-federation).
>
>  -  `SECRET_KEY` is a random string that is used for encrypting the session
>     data.  You can generate a new key using the following command:
>
>     ~~~~ sh
>     openssl rand -hex 32
>     ~~~~
>
>  -  `INSTANCE_ACTOR_KEY` is a RSA private key with JWK format.  You can
>     generate a new key using the following command:
>
>     ~~~~ sh
>     mise run keygen
>     ~~~~
>
>     Warn that you should quote the key value with single quotes in the *.env*
>     file, e.g., `INSTANCE_ACTOR_KEY='{"kty":"RSA",...}'`.
>
>  -  `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` are used by
>     browser Web Push notifications.  You can generate a pair in *.env* format
>     using the following command:
>
>     ~~~~ sh
>     mise run generate-vapid-keys
>     ~~~~
>
>     `WEB_PUSH_VAPID_SUBJECT` identifies the server to browser push services.
>     Use a contact URI such as `mailto:admin@example.com` or a public HTTPS
>     origin such as `https://example.com/`.  Localhost is a secure context for
>     browser testing, but remote development and production deployments need
>     HTTPS for browser Push API subscriptions.
>
>  -  `KV_URL` may point to a file when running only `mise run dev:graphql` or
>     `mise run dev:graphql:node`. Redis is required whenever the worker is
>     running and for every production process, because those processes must
>     share one coherent KV store.
>
>  -  `DRIVE_DISK` can be set to `fs` to use the file system for storing files.
>     In this case, you also need to set `FS_LOCATION` to the directory where
>     the files will be stored, which can be a relative path to the project
>     directory, e.g., `FS_LOCATION=./media`.
>
>     For your information, the *media/* directory under the project directory
>     is listed in the *.gitignore* file, so you don't need to worry about
>     accidentally committing the files to the repository.
>
>  -  `MAILGUN_API_KEY` is the API key for sending emails.  You can use a
>     [Mailgun] account for this.  However, if you won't test sending emails
>     (e.g., for sign up or sending invitations), you can omit this variable.
>
>  -  `ANTHROPIC_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` are the API keys
>     for summarizing and translating posts using LLMs.  You can use
>     [Anthropic] and [Google Generative AI] accounts for this.  However, if
>     you won't test these features, you can omit these variables.
>
>  -  `FUTURE_TIMESTAMP_TOLERANCE` is the tolerance period in milliseconds for
>     posts with future timestamps. Posts published more than this time in the
>     future will be filtered out from timelines. Default value is 300000 (5
>     minutes). This helps prevent malicious or misconfigured remote servers
>     from disrupting timeline order with posts that have future timestamps.


Starting Redis
--------------

The sample configuration sets `KV_URL=redis://localhost:6379/0`, so Redis must
be listening on port 6379 before running `mise run addaccount` or either
standalone GraphQL process.  Install Redis using the
[official instructions][Redis] for your operating system, then start it.  For
example:

 -  On macOS with the current Homebrew cask, run:

    ~~~~ sh
    brew tap redis/redis
    brew install --cask redis
    redis-server "$(brew --prefix)/etc/redis.conf"
    ~~~~

 -  On Ubuntu or Debian after installing the official Redis packages, run:

    ~~~~ sh
    sudo systemctl enable redis-server
    sudo systemctl start redis-server
    ~~~~

Verify the server before continuing:

~~~~ sh
redis-cli ping
~~~~

The command should print `PONG`.  If you use `docker compose up` instead of
running the services directly, Compose provides and configures Redis for you.


Creating a database schema
--------------------------

Before running the server, you need to create the database schema.  To do this,
you need to run the database migrations:

~~~~ sh
mise run migrate
~~~~


Migrating legacy filesystem media
---------------------------------

Installations upgraded from the removed Fresh application may still have
uploads under the old filesystem-storage root.  Before starting the new
filesystem-backed services, copy them to the new application-relative root
with:

~~~~ sh
mise run migrate:media
~~~~

The migration reads `FS_LOCATION` (defaulting to `./media`).  For example,
`FS_LOCATION=./uploads` copies *web/uploads/* to *uploads/*.  Absolute paths do
not need moving because their resolution is unchanged.  Each file is completed
under a temporary name and installed atomically, so an interrupted copy can be
retried without leaving a partial destination file.

The migration is safe to repeat: it leaves the legacy files in place, skips
identical files already copied, and stops rather than overwriting different
content at the same path.  Verify the migrated uploads before removing the old
filesystem-storage directory.  `docker compose up` runs this media migration
automatically before the database migration and application services.


Creating the first account
--------------------------

To create the first account, you need to run the following command:

~~~~ sh
mise run addaccount your@email.com
~~~~

This command creates a sign up token for the first account.  You can use any
email address you want.  The command will print a link to the console.
You can use this link to sign up for the first account after running the server.


Running the server
------------------

The easiest way to run the complete application is Compose:

~~~~ sh
docker compose up
~~~~

This starts PostgreSQL, Redis, the GraphQL API, the federation worker,
web-next, and the gateway.  Access the application at http://localhost:8000/.

For focused development, run the API, worker, and frontend in separate
terminals:

~~~~ sh
mise run dev:graphql
mise run dev:graphql-worker
API_URL=http://localhost:8080/graphql mise run dev:web-next
~~~~

Use `mise run dev:graphql:node` instead of `mise run dev:graphql` to exercise
the candidate Node.js API runtime.  Both commands expose the same HTTP surface;
the Deno command remains the rollback path until the deployment cutover.

The direct frontend is available at http://localhost:3000/.  It does not
provide the unified ActivityPub routing that the Compose gateway provides.
If watchman is unavailable, set `NO_WATCHMAN=1` and run
`mise run next:codegen` whenever GraphQL documents change.

For API-only development, `mise run dev:graphql` and
`mise run dev:graphql:node` also accept a file-backed `KV_URL` such as
`file:///tmp/hackerspub-kv.json`.  Do not start the worker in this mode:
federation queues and scheduled jobs remain inactive.  Use Redis for the
complete API, worker, and frontend topology shown above.


Setting up federation
---------------------

Since Hackers' Pub is a federated platform through ActivityPub, you would need
to set up federation to test how your changes affect the federation.  To do
this, you need to place your local server behind a reverse proxy that supports
tunneling.

There are quite [many options available][1], but we recommend using [ngrok]
for one-time contributions.

> [!TIP]
> If you are a regular contributor, you may want to use a more permanent
> solution, such as [Tailscale Funnel] or [Cloudflare Tunnel].

1.  Configure `BEHIND_PROXY=true` in the *.env* file.

2.  Create an account on [ngrok].

3.  [Install `ngrok` and connect your account.][2]

4.  Start the tunnel by executing the following command (ensuring your local
    server is running on port 8000):

    ~~~~ sh
    ngrok http 8000
    ~~~~

5.  Copy the HTTPS URL provided by `ngrok`, and put it in the `ORIGIN`
    environment variable in the *.env* file.

6.  Restart the server, and you are ready to test federation.

When testing federation, you must use the HTTPS URL provided by `ngrok` as the
base URL for your local server.  This is because ActivityPub requires
the server to be accessible over HTTPS.

When you build new UI in *web-next/*, follow the conventions documented in
[*DESIGN.md*](./DESIGN.md) — it covers the color tokens, typography, component
patterns (solid-ui in the New York style), and brand asset usage.

[ngrok]: https://ngrok.com/
[Tailscale Funnel]: https://tailscale.com/kb/1223/funnel
[Cloudflare Tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[1]: https://fedify.dev/manual/test#exposing-a-local-server-to-the-public
[2]: https://ngrok.com/docs/getting-started/


Setting up Visual Studio Code
-----------------------------

We recommend using [Visual Studio Code] for development.  To set up Visual
Studio Code for this project, follow these steps:

1.  Run `code` in the project directory to open the project in Visual Studio
    Code.
2.  Trust the workspace by clicking the <q>Trust the authors of all files in the
    workspace</q> button when prompted.
3.  Install the recommended extensions when prompted.

That's it!  You are now ready to start coding.

[Visual Studio Code]: https://code.visualstudio.com/


Want other tools?
-----------------

If you are a passionate user of other tools, such as Vim or Emacs, you need to
manually set up the project for those tools.  Configure the editor to use the
repository's TypeScript configuration and the Node.js version pinned by mise.


Running tests
-------------

We encourage you to write tests for your changes.  Tests use the
`node:test` API so they run under Node.js without transpilation.  The aggregate
task also runs the same suite under Deno while backend runtime migration is in
progress:

~~~~ sh
mise run test
~~~~

Use `mise run test:node` for the primary Node.js suite, or
`mise run test:deno` to investigate Deno compatibility specifically.


Before submitting a pull request
--------------------------------

Before submitting a pull request, ensure that your changes pass the tests and
that you have formatted the code and Markdown using `mise run fmt`.  Oxfmt
formats TypeScript and configuration files, and Hongdown formats Markdown.
The following command runs Oxfmt and Hongdown checks, Oxlint, TypeScript type
checking, generated artifact checks, and the transitional Deno checks:

~~~~ sh
mise run check
~~~~

> [!TIP]
> `mise install` installs this hook automatically.  To refresh it manually, run:
>
> ~~~~ sh
> mise generate git-pre-commit --write --task=check
> ~~~~


License
-------

By contributing to this project, you agree to license your contributions under
the [Affero General Public License version 3][AGPL-3.0].  You also assert that
you have the right to license your contribution under this license.

[AGPL-3.0]: https://www.gnu.org/licenses/agpl-3.0.html
