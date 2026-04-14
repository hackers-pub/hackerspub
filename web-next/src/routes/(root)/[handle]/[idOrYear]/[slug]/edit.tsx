import {
  query,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createFragment,
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import { Button } from "~/components/ui/button.tsx";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { editPageQuery } from "./__generated__/editPageQuery.graphql.ts";
import type { edit_article$key } from "./__generated__/edit_article.graphql.ts";
import type { edit_updateArticle_Mutation } from "./__generated__/edit_updateArticle_Mutation.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const handle = args.params.handle!;
    const idOrYear = args.params.idOrYear!;
    const slug = args.params.slug!;
    void loadPageQuery(handle, idOrYear, slug);
  },
} satisfies RouteDefinition;

const editPageQueryDef = graphql`
  query editPageQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
    ) {
      ...edit_article
    }
  }
`;

const loadPageQuery = query(
  (handle: string, idOrYear: string, slug: string) =>
    loadQuery<editPageQuery>(
      useRelayEnvironment()(),
      editPageQueryDef,
      { handle, idOrYear, slug },
    ),
  "loadArticleEditPageQuery",
);

export default function ArticleEditPage() {
  const params = useParams();
  const handle = params.handle!;
  const idOrYear = params.idOrYear!;
  const slug = params.slug!;

  const data = createPreloadedQuery<editPageQuery>(
    editPageQueryDef,
    () => loadPageQuery(handle, idOrYear, slug),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <Show
          when={data().articleByYearAndSlug}
          fallback={<HttpStatusCode code={404} />}
        >
          {(article) => <ArticleEditForm $article={article()} />}
        </Show>
      )}
    </Show>
  );
}

interface ArticleEditFormProps {
  $article: edit_article$key;
}

const updateArticleMutation = graphql`
  mutation edit_updateArticle_Mutation($input: UpdateArticleInput!) {
    updateArticle(input: $input) {
      __typename
      ... on UpdateArticlePayload {
        article {
          id
          url
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

function ArticleEditForm(props: ArticleEditFormProps) {
  const { t } = useLingui();
  const navigate = useNavigate();

  const article = createFragment(
    graphql`
      fragment edit_article on Article {
        id
        actor {
          isViewer
          username
        }
        contents {
          title
          rawContent
          language
          originalLanguage
        }
        tags
        allowLlmTranslation
        publishedYear
        slug
      }
    `,
    () => props.$article,
  );

  const [commitUpdate, isUpdating] = createMutation<
    edit_updateArticle_Mutation
  >(updateArticleMutation);

  // Initialize form state from the original content (not translations)
  const content = () =>
    article()?.contents?.find((c) => c.originalLanguage == null);
  const [title, setTitle] = createSignal(content()?.title ?? "");
  const [markdown, setMarkdown] = createSignal(content()?.rawContent ?? "");
  const [tags, setTags] = createSignal<string[]>([...(article()?.tags ?? [])]);
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    content()?.language ? new Intl.Locale(content()!.language) : undefined,
  );
  const [allowLlmTranslation, setAllowLlmTranslation] = createSignal(
    article()?.allowLlmTranslation ?? false,
  );

  const handleSave = () => {
    const a = article();
    if (!a) return;

    commitUpdate({
      variables: {
        input: {
          articleId: a.id,
          title: title(),
          content: markdown(),
          tags: tags(),
          language: language()?.baseName,
          allowLlmTranslation: allowLlmTranslation(),
        },
      },
      onCompleted(response) {
        if (
          response.updateArticle.__typename === "UpdateArticlePayload"
        ) {
          showToast({
            title: t`Success`,
            description: t`Article updated`,
            variant: "success",
          });
          const articleUrl = response.updateArticle.article.url;
          if (articleUrl) {
            navigate(new URL(articleUrl).pathname);
          }
        } else if (
          response.updateArticle.__typename === "InvalidInputError"
        ) {
          const inputPath = response.updateArticle.inputPath;
          showToast({
            title: t`Error`,
            description: inputPath === "language"
              ? t`Cannot change the language because translations already exist`
              : t`Invalid input: ${inputPath}`,
            variant: "error",
          });
        } else if (
          response.updateArticle.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to edit an article`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  return (
    <Show
      when={article()?.actor.isViewer}
      fallback={<HttpStatusCode code={403} />}
    >
      <div class="mt-8 mb-4 px-4 max-w-3xl mx-auto">
        <h1 class="text-2xl font-bold mb-6">{t`Edit Article`}</h1>

        <div class="flex flex-col gap-6">
          {/* Title */}
          <TextField>
            <TextFieldLabel>{t`Title`}</TextFieldLabel>
            <TextFieldInput
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              placeholder={t`Please enter a title for your article.`}
              required
              class="text-2xl font-bold"
            />
          </TextField>

          {/* Content */}
          <div class="flex flex-col gap-1">
            <label class="flex items-center justify-between text-sm font-medium">
              <span>{t`Content`}</span>
              <a
                href="/markdown"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
              >
                <svg
                  fill="currentColor"
                  height="128"
                  viewBox="0 0 208 128"
                  width="208"
                  xmlns="http://www.w3.org/2000/svg"
                  class="size-4"
                  stroke="currentColor"
                >
                  <g>
                    <path
                      clip-rule="evenodd"
                      d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                      fill-rule="evenodd"
                    />
                    <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
                  </g>
                </svg>
                {t`Markdown supported`}
              </a>
            </label>
            <MarkdownEditor
              value={markdown()}
              onInput={setMarkdown}
              placeholder={t`Write your article here.`}
              showToolbar
              minHeight="400px"
            />
          </div>

          {/* Tags */}
          <div>
            <label class="text-sm font-medium">{t`Tags`}</label>
            <TagInput
              value={tags()}
              onChange={setTags}
              placeholder={t`Type tags separated by spaces`}
              class="mt-2"
            />
          </div>

          {/* Language */}
          <div>
            <label class="text-sm font-medium">{t`Language`}</label>
            <LanguageSelect
              value={language()}
              onChange={setLanguage}
              class="mt-2"
            />
          </div>

          {/* Allow LLM Translation */}
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allowLlmTranslation()}
              onChange={(e) => setAllowLlmTranslation(e.currentTarget.checked)}
              class="rounded border-input"
            />
            <span class="text-sm">
              {t`Allow automatic translation by AI`}
            </span>
          </label>

          {/* Actions */}
          <div class="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => {
                const a = article();
                if (a) {
                  navigate(
                    `/@${a.actor.username}/${a.publishedYear}/${a.slug}`,
                  );
                }
              }}
            >
              {t`Cancel`}
            </Button>
            <Button
              onClick={handleSave}
              disabled={isUpdating()}
            >
              {isUpdating() ? t`Saving...` : t`Save Changes`}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
