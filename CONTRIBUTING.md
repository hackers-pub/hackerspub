<!-- deno-fmt-ignore-file -->

Contribution guide
==================

We welcome contributions to the project. Please read the following guide to
learn how to contribute.


Recommended reading
-------------------

Hackers' Pub uses the following technologies:

 -  [Deno] for the backend
 -  [PostgreSQL] for the database
 -  [Fresh] 2.0 for web framework[^1]
 -  [Drizzle ORM] for database operations
 -  [Keyv] for caching
 -  [Fedify] for ActivityPub federation
 -  [Pothos] for GraphQL schema builder
 -  [Yoga] for GraphQL server
 -  [LogTape] for logging
 -  [Preact] for web frontend
 -  [Tailwind CSS] for styling
 -  [Vercel AI SDK] for LLM integration
 -  [i18next] for internationalization
 -  [ffmpeg] for video processing

If you are not familiar with these technologies, we recommend reading the
documentation of these technologies to understand how they work.

[^1]: As of February 2025, Fresh 2.0 is not released.  We are using
      the development version of Fresh 2.0, which is not well-documented.
      We recommend reading the source code of Fresh 2.0 to understand how it
      works.

[Deno]: https://deno.com/
[PostgreSQL]: https://www.postgresql.org/
[Fresh]: https://fresh.deno.dev/
[Drizzle ORM]: https://orm.drizzle.team/
[Keyv]: https://keyv.org/
[Fedify]: https://fedify.dev/
[Pothos]: https://pothos-graphql.dev/
[Yoga]: https://www.graphql-yoga.com/
[LogTape]: https://logtape.org/
[Preact]: https://preactjs.com/
[Tailwind CSS]: https://tailwindcss.com/
[Vercel AI SDK]: https://ai-sdk.dev/
[i18next]: https://www.i18next.com/
[ffmpeg]: https://ffmpeg.org/


Prerequisites
-------------

To build the project, you need to have the following tools installed:

 -  [Deno] 2.2 or higher
 -  [PostgreSQL] 17 or higher
 -  [ffmpeg] 5.0 or higher
 -  [Mailgun] account (optional; for sending emails)
 -  [Anthropic] API key (optional; for translating posts)
 -  [Google Generative AI] API key (optional; for summarizing posts)

Any other dependencies can be installed using Deno:

~~~~ sh
deno install
~~~~

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
>     deno task keygen
>     ~~~~
>
>     Warn that you should quote the key value with single quotes in the *.env*
>     file, e.g., `INSTANCE_ACTOR_KEY='{"kty":"RSA",...}'`.
>
>  -  `KV_URL` can start with `file://` to use a file-based cache, e.g.,
>     `KV_URL=file:///tmp/kv.db`.
>
>  -  `DRIVE_DISK` can be set to `fs` to use the file system for storing files.
>
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


Creating a database schema
--------------------------

Before running the server, you need to create the database schema.  To do this,
you need to run the database migrations:

~~~~ sh
deno task migrate
~~~~


Creating the first account
--------------------------

To create the first account, you need to run the following command:

~~~~ sh
deno task addaccount your@email.com
~~~~

This command creates a sign up token for the first account.  You can use any
email address you want.  The command will print a link to the console.
You can use this link to sign up for the first account after running the server.


Running the server
------------------

To run the server, execute the following command:

~~~~ sh
deno task dev
~~~~

This command starts the server on port 8000.


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

 1. Configure `BEHIND_PROXY=true` in the *.env* file.

 2. Create an account on [ngrok].

 3. [Install `ngrok` and connect your account.][2]

 4. Start the tunnel by executing the following command (ensuring your local
    server is running on port 8000):

    ~~~~ sh
    ngrok http 8000
    ~~~~

 5. Copy the HTTPS URL provided by `ngrok`, and put it in the `ORIGIN`
    environment variable in the *.env* file.

 6. Restart the server, and you are ready to test federation.

When testing federation, you must use the HTTPS URL provided by `ngrok` as the
base URL for your local server.  This is because ActivityPub requires
the server to be accessible over HTTPS.

[1]: https://fedify.dev/manual/test#exposing-a-local-server-to-the-public
[ngrok]: https://ngrok.com/
[Tailscale Funnel]: https://tailscale.com/kb/1223/funnel
[Cloudflare Tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[2]: https://ngrok.com/docs/getting-started/


Setting up Visual Studio Code
-----------------------------

We recommend using [Visual Studio Code] for development.  To set up Visual
Studio Code for this project, follow these steps:

 1. Run `code` in the project directory to open the project in Visual Studio
    Code.
 2. Trust the workspace by clicking the <q>Trust the authors of all files in the
    workspace</q> button when prompted.
 3. Install the recommended extensions when prompted.

That's it!  You are now ready to start coding.

[Visual Studio Code]: https://code.visualstudio.com/


Want other tools?
-----------------

If you are a passionate user of other tools, such as Vim or Emacs, you need to
manually set up the project for those tools.  We recommend following the [Deno's
official guide for setting up your favorite editor][3].

[3]: https://docs.deno.com/runtime/getting_started/setup_your_environment/


Running tests
-------------

Currently, we don't have many tests.  However, we encourage you to write tests
for your changes.  To run the tests, execute the following command:

~~~~ sh
deno task test
~~~~


Before submitting a pull request
--------------------------------

Before submitting a pull request, ensure that your changes pass the tests and
that you have formatted the code using `deno fmt`.  You can use the following
command to check the code formatting and run lint checks:

~~~~ sh
deno task check
~~~~

> [!TIP]
> Or, you can use the following command to install a *pre-commit* hook that
> checks the code formatting and runs lint checks before committing:
>
> ~~~~ sh
> deno task hooks:install
> ~~~~


License
-------

By contributing to this project, you agree to license your contributions under
the [Affero General Public License version 3][AGPL-3.0].  You also assert that
you have the right to license your contribution under this license.

[AGPL-3.0]: https://www.gnu.org/licenses/agpl-3.0.html
