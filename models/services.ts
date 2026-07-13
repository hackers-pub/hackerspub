import type * as vocab from "@fedify/vocab";
import type { ApplicationModel } from "./context.ts";
import type { CocProvision } from "./coc.ts";
import type { ReactionEmoji } from "./emoji.ts";
import type {
  Account,
  Actor,
  ArticleContent,
  ArticleSource,
  CustomEmoji,
  Medium,
  Mention,
  NoteSource,
  NoteSourceMedium,
  Poll,
  PollOption,
  Post,
  PostVisibility,
  QuotePolicy,
  Reaction,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export interface SummaryOptions {
  model: ApplicationModel;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
}

export interface TranslationOptions {
  model: ApplicationModel;
  summarizationModel?: ApplicationModel;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  authorName?: string;
  authorBio?: string;
  tags?: string[];
}

export interface ModerationAnalysisMatch {
  provision: string;
  confidence: number;
  rationale: string;
}

export interface ModerationAnalysis {
  matches: ModerationAnalysisMatch[];
  summary: string;
}

export interface ModerationAnalysisOptions {
  model: ApplicationModel;
  provisions: readonly CocProvision[];
  reason: string;
  contentHtml: string;
  contentKind?: string;
}

export interface AiServices {
  readonly analyzeFlaggedContent: (
    options: ModerationAnalysisOptions,
  ) => Promise<ModerationAnalysis>;
  readonly summarize: (options: SummaryOptions) => Promise<string>;
  readonly translate: (options: TranslationOptions) => Promise<string>;
}

export interface SendTagsPubRelayOptions {
  readonly orderingKey: string;
  readonly visibility: PostVisibility;
  readonly accountBio: string | null;
  readonly relayedTags?: readonly string[] | Record<string, string>;
}

export interface FederationServices<TContext> {
  readonly subscribeTagsPubHashtag: (
    context: TContext,
    tag: string,
  ) => Promise<void>;
  readonly unsubscribeTagsPubHashtag: (
    context: TContext,
    tag: string,
  ) => Promise<void>;
  readonly getAnnounce: (
    context: TContext,
    share: Post & {
      actor: Actor & { account: Account };
      sharedPost: Post;
      mentions: (Mention & { actor: Actor })[];
    },
  ) => vocab.Announce;
  readonly getArticle: (
    context: TContext,
    articleSource: ArticleSource & {
      account: Account;
      contents: ArticleContent[];
    },
  ) => Promise<vocab.Article>;
  readonly getEmojiReact: (
    context: TContext,
    reaction: Reaction & {
      actor: Actor;
      customEmoji?: CustomEmoji | null;
      post: Post & { actor: Actor };
    },
  ) => vocab.Like | vocab.EmojiReact | null;
  readonly getEmojiReactId: (
    context: TContext,
    accountId: Uuid,
    postId: Uuid,
    emoji: ReactionEmoji,
  ) => URL;
  readonly getNote: (
    context: TContext,
    note: NoteSource & {
      account: Account;
      media: (NoteSourceMedium & { medium: Medium })[];
    },
    relations?: {
      replyTargetId?: URL;
      quotedPost?: Post;
      quoteAuthorizationIri?: string | null;
      quoteRequestPolicy?: QuotePolicy | null;
    },
  ) => Promise<vocab.Note>;
  readonly getQuestion: (
    context: TContext,
    note: NoteSource & {
      account: Account;
      media: (NoteSourceMedium & { medium: Medium })[];
    },
    poll: Poll & { options: PollOption[]; post: Pick<Post, "name"> },
    relations?: {
      replyTargetId?: URL;
      quotedPost?: Post;
      quoteAuthorizationIri?: string | null;
      quoteRequestPolicy?: QuotePolicy | null;
    },
  ) => Promise<vocab.Question>;
  readonly sendTagsPubRelayActivity: (
    context: TContext,
    accountId: Uuid,
    activity: vocab.Activity,
    options: SendTagsPubRelayOptions,
  ) => Promise<readonly string[] | undefined>;
}

export interface ApplicationServices<TFederationContext> {
  readonly ai: AiServices;
  readonly federation: FederationServices<TFederationContext>;
}
