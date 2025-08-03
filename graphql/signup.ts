import { syncActorFromAccount } from "@hackerspub/models/actor";
import { follow } from "@hackerspub/models/following";
import { createSession } from "@hackerspub/models/session";
import {
  createAccount,
  deleteSignupToken,
  getSignupToken,
} from "@hackerspub/models/signup";
import {
  BioValidationError,
  DisplayNameValidationError,
  UsernameValidationError,
  validateBio,
  validateDisplayName,
  validateUsername,
} from "@hackerspub/models/userValidation";
import {
  generateUuidV7,
  type Uuid,
  validateUuid,
} from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { createGraphQLError } from "graphql-yoga";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { SessionRef } from "./session.ts";

const logger = getLogger(["hackerspub", "graphql", "signup"]);

interface SignupInfo {
  email: string;
  inviterId?: Uuid;
}

interface SignupInput {
  username: string;
  name: string;
  bio: string;
}

interface SignupValidationErrors {
  username?: UsernameValidationError | "USERNAME_ALREADY_TAKEN";
  name?: DisplayNameValidationError;
  bio?: BioValidationError;
}

const SignupInfoRef = builder.objectRef<SignupInfo>(
  "SignupInfo",
);

SignupInfoRef.implement({
  description:
    "A signup info containing email and inviter information for account creation.",
  fields: (t) => ({
    email: t.exposeString("email"),
    inviter: t.field({
      type: Account,
      nullable: true,
      async resolve(info, _, ctx) {
        if (!info.inviterId) return null;
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: info.inviterId },
          with: { actor: true },
        });
        return account || null;
      },
    }),
  }),
});

const SignupInputRef = builder.inputRef<SignupInput>("SignupInput");

SignupInputRef.implement({
  description: "Input data for completing account signup.",
  fields: (t) => ({
    username: t.string({ required: true }),
    name: t.string({ required: true }),
    bio: t.string({ required: true }),
  }),
});

const SignupUsernameError = builder.enumType("SignupUsernameError", {
  values: {
    USERNAME_REQUIRED: { value: UsernameValidationError.Required },
    USERNAME_TOO_LONG: { value: UsernameValidationError.TooLong },
    USERNAME_INVALID_CHARACTERS: {
      value: UsernameValidationError.InvalidCharacters,
    },
    USERNAME_ALREADY_TAKEN: { value: "USERNAME_ALREADY_TAKEN" },
  },
});

const SignupDisplayNameError = builder.enumType("SignupDisplayNameError", {
  values: {
    DISPLAY_NAME_REQUIRED: { value: DisplayNameValidationError.Required },
    DISPLAY_NAME_TOO_LONG: { value: DisplayNameValidationError.TooLong },
  },
});

const SignupBioError = builder.enumType("SignupBioError", {
  values: {
    BIO_TOO_LONG: { value: BioValidationError.TooLong },
  },
});

const SignupValidationErrorsRef = builder.objectRef<SignupValidationErrors>(
  "SignupValidationErrors",
);

SignupValidationErrorsRef.implement({
  description: "Validation errors for signup fields.",
  fields: (t) => ({
    username: t.field({
      type: SignupUsernameError,
      nullable: true,
      resolve: (parent) => parent.username || null,
    }),
    name: t.field({
      type: SignupDisplayNameError,
      nullable: true,
      resolve: (parent) => parent.name || null,
    }),
    bio: t.field({
      type: SignupBioError,
      nullable: true,
      resolve: (parent) => parent.bio || null,
    }),
  }),
});

const SignupResultRef = builder.unionType("SignupResult", {
  types: [SessionRef, SignupValidationErrorsRef],
  resolveType: (obj) => {
    if ("accountId" in obj) return SessionRef;
    return SignupValidationErrorsRef;
  },
});

builder.queryFields((t) => ({
  verifySignupToken: t.field({
    type: SignupInfoRef,
    nullable: true,
    description: "Verify a signup token and return the signup info if valid.",
    args: {
      token: t.arg({
        type: "UUID",
        required: true,
        description: "The signup token to verify.",
      }),
      code: t.arg.string({
        required: true,
        description: "The verification code.",
      }),
    },
    async resolve(_, args, ctx) {
      if (!validateUuid(args.token)) {
        throw createGraphQLError("Invalid token format");
      }

      const signupToken = await getSignupToken(ctx.kv, args.token);
      if (!signupToken) {
        return null;
      }

      if (signupToken.code !== args.code) {
        return null;
      }

      const existingAccount = await ctx.db.query.accountEmailTable.findFirst({
        where: { email: signupToken.email },
      });

      if (existingAccount) {
        return null;
      }

      return {
        email: signupToken.email,
        inviterId: signupToken.inviterId,
      };
    },
  }),
}));

builder.mutationFields((t) => ({
  completeSignup: t.field({
    type: SignupResultRef,
    description:
      "Complete the signup process by creating a new account and session.",
    args: {
      token: t.arg({
        type: "UUID",
        required: true,
        description: "The signup token.",
      }),
      code: t.arg.string({
        required: true,
        description: "The verification code.",
      }),
      input: t.arg({
        type: SignupInputRef,
        required: true,
        description: "The account creation data.",
      }),
    },
    async resolve(_, args, ctx) {
      if (!validateUuid(args.token)) {
        throw createGraphQLError("Invalid token format");
      }

      const signupToken = await getSignupToken(ctx.kv, args.token);
      if (!signupToken) {
        throw createGraphQLError("Invalid or expired signup token");
      }

      if (signupToken.code !== args.code) {
        throw createGraphQLError("Invalid verification code");
      }

      const existingAccount = await ctx.db.query.accountEmailTable.findFirst({
        where: { email: signupToken.email },
      });

      if (existingAccount) {
        throw createGraphQLError("Email is already registered");
      }

      const { username, name, bio = "" } = args.input;
      const trimmedUsername = username.trim().toLowerCase();
      const trimmedName = name.trim();

      // Collect validation errors
      const errors: SignupValidationErrors = {};

      // Validate username
      const usernameError = validateUsername(trimmedUsername);
      if (usernameError) {
        errors.username = usernameError;
      } else {
        const existingUser = await ctx.db.query.accountTable.findFirst({
          where: { username: trimmedUsername },
        });
        if (existingUser) {
          errors.username = "USERNAME_ALREADY_TAKEN";
        }
      }

      // Validate name
      const nameError = validateDisplayName(trimmedName);
      if (nameError) {
        errors.name = nameError;
      }

      // Validate bio
      const bioError = validateBio(bio);
      if (bioError) {
        errors.bio = bioError;
      }

      // Return validation errors if any
      if (errors.username || errors.name || errors.bio) {
        return errors;
      }

      const account = await createAccount(ctx.db, signupToken, {
        id: generateUuidV7(),
        username: trimmedUsername,
        name: trimmedName,
        bio,
        leftInvitations: 0,
      });

      if (!account) {
        throw createGraphQLError("Failed to create account");
      }

      const actor = await syncActorFromAccount(ctx.fedCtx, {
        ...account,
        links: [],
      });

      await deleteSignupToken(ctx.kv, signupToken.token);

      if (signupToken.inviterId) {
        const inviter = await ctx.db.query.accountTable.findFirst({
          where: { id: signupToken.inviterId },
          with: { actor: true },
        });

        if (inviter) {
          await follow(ctx.fedCtx, { ...account, actor }, inviter.actor);
          await follow(ctx.fedCtx, inviter, actor);
        }
      }

      logger.info("Account created successfully: {accountId}", {
        accountId: account.id,
      });

      // Create session for the new account
      const remoteAddr = ctx.connectionInfo?.remoteAddr;
      const session = await createSession(ctx.kv, {
        accountId: account.id,
        userAgent: ctx.request.headers.get("user-agent") ?? null,
        ipAddress: remoteAddr?.transport === "tcp" ? remoteAddr.hostname : null,
      });

      return session;
    },
  }),
}));
