// Compatibility facade for the historical `graphql/post.ts` module.
// Schema registration is split by feature under `graphql/post/`.
import "./post/mutations.ts";

export {
  hidePostRelationWithoutActor,
  isPostVisibleToViewer,
  Medium,
  Post,
  PostLink,
  PostType,
} from "./post/core.ts";
export { Article, ArticleContent, ArticleDraft } from "./post/article.ts";
export { Note, Question } from "./post/note.ts";
