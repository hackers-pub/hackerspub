import { useSignal } from "@preact/signals";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { escape as htmlEscape } from "@std/html/entities";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import getFixedT from "../i18n.ts";
import type { Language } from "../i18n.ts";
import type { ActorInfo } from "../routes/api/webfinger.ts";

export interface RemoteFollowModalProps {
  isOpen: boolean;
  onClose: () => void;
  actorHandle: string;
  actorName?: string;
  language: Language;
}

export function RemoteFollowModal(
  { isOpen, onClose, actorHandle, actorName, language }: RemoteFollowModalProps,
) {
  const fediverseId = useSignal("");
  const errorMessage = useSignal("");
  const isLoading = useSignal(false);
  const actionInfo = useSignal<ActorInfo | null>(null);
  const t = getFixedT(language);

  const validateFediverseId = (id: string): boolean => {
    // Fediverse ID format: @username@domain.com or username@domain.com
    const fediverseIdRegex =
      /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
    return fediverseIdRegex.test(id.trim());
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    const inputId = fediverseId.value.trim();
    if (!inputId) {
      errorMessage.value = t("remoteFollow.fediverseIdRequired");
      return;
    }

    // Validate Fediverse ID format
    if (!validateFediverseId(inputId)) {
      errorMessage.value = t("remoteFollow.fediverseIdInvalid");
      return;
    }

    // General Fediverse user: webfinger lookup through server API
    try {
      isLoading.value = true;
      errorMessage.value = "";

      const response = await fetch("/api/webfinger", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fediverseId: inputId, actorHandle, language }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t("remoteFollow.userLookupError"));
      }

      if (!data.actor) {
        throw new Error(t("remoteFollow.userNotFound"));
      }
      // Store user information in state to display in UI
      actionInfo.value = data.actor;
    } catch (error) {
      errorMessage.value = error instanceof Error
        ? error.message
        : t("remoteFollow.userLookupError");
      actionInfo.value = null;
    } finally {
      isLoading.value = false;
    }
  };

  const handleBackdropClick = (e: Event) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleInputChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    fediverseId.value = target.value;
    // Clear error message and user data while typing
    if (errorMessage.value) {
      errorMessage.value = "";
    }
    if (actionInfo.value) {
      actionInfo.value = null;
    }
  };

  const handleFollowClick = () => {
    if (!actionInfo.value) return;

    const remoteFollowUrl = `https://${actionInfo.value.domain}/${
      encodeURI(actorHandle)
    }`;
    // Open remote follow page in new tab
    window.open(remoteFollowUrl, "_blank", "noopener,noreferrer");
    onClose();
  };

  if (!isOpen) return null;

  return (
    <TranslationSetup language={language}>
      <div
        class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        onClick={handleBackdropClick}
      >
        <div class="bg-white dark:bg-stone-800 rounded-lg p-6 max-w-md w-full mx-4">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-lg font-semibold">
              <Msg $key="remoteFollow.title" />
            </h2>
            <button
              type="button"
              onClick={onClose}
              class="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                class="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div class="mb-4">
            <p class="text-sm text-gray-600 dark:text-gray-300 mb-2">
              <Msg
                $key="remoteFollow.description"
                actorName={actorName || actorHandle}
              />
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              <Msg $key="remoteFollow.fediverseIdExample" />
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div class="mb-4">
              <label
                htmlFor="fediverseId"
                class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2"
              >
                <Msg $key="remoteFollow.fediverseIdLabel" />
              </label>
              <input
                id="fediverseId"
                type="text"
                placeholder={t("remoteFollow.fediverseIdPlaceholder")}
                value={fediverseId.value}
                onInput={handleInputChange}
                disabled={isLoading.value}
                class={`w-full px-3 py-2 border rounded-md bg-white dark:bg-stone-700 text-gray-900 dark:text-gray-100 disabled:opacity-50 ${
                  errorMessage.value
                    ? "border-red-500 dark:border-red-400"
                    : "border-gray-300 dark:border-gray-600"
                }`}
                required
              />
              {errorMessage.value && (
                <p class="text-red-500 text-xs mt-1">{errorMessage.value}</p>
              )}
              {isLoading.value && (
                <p class="text-blue-500 text-xs mt-1">
                  <Msg $key="remoteFollow.lookingUpUser" />
                </p>
              )}
            </div>

            {actionInfo.value && (
              <div class="mb-4 p-3 border rounded-md bg-gray-50 dark:bg-stone-700">
                <div class="flex items-start gap-3">
                  {actionInfo.value.icon && (
                    <img
                      src={actionInfo.value.icon}
                      alt={t("remoteFollow.profileImageAlt")}
                      class="w-10 h-10 rounded-full flex-shrink-0"
                    />
                  )}
                  <div class="flex-1">
                    <h4
                      class="font-medium text-gray-900 dark:text-gray-100"
                      dangerouslySetInnerHTML={{
                        __html: renderCustomEmojis(
                          htmlEscape(
                            actionInfo.value.name ||
                              actionInfo.value.preferredUsername ||
                              actionInfo.value.handle?.split("@")[0] ||
                              "",
                          ),
                          actionInfo.value.emojis || {},
                        ),
                      }}
                    />
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                      {actionInfo.value.handle}
                    </p>
                    {actionInfo.value.software &&
                      actionInfo.value.software !== "unknown" && (
                      <p class="text-xs text-gray-500 dark:text-gray-500">
                        {actionInfo.value.software.charAt(0).toUpperCase() +
                          actionInfo.value.software.slice(1)}
                      </p>
                    )}
                    {actionInfo.value.summary && (
                      <p
                        class="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2 overflow-hidden"
                        dangerouslySetInnerHTML={{
                          __html: renderCustomEmojis(
                            htmlEscape(
                              actionInfo.value.summary.replace(/<[^>]*>/g, "")
                                .substring(0, 100) +
                                (actionInfo.value.summary.length > 100
                                  ? "..."
                                  : ""),
                            ),
                            actionInfo.value.emojis || {},
                          ),
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            <div class="flex gap-3">
              <Button
                type="button"
                onClick={onClose}
                class="flex-1 bg-gray-100 dark:bg-stone-700 hover:bg-gray-200 dark:hover:bg-stone-600"
              >
                <Msg $key="remoteFollow.cancel" />
              </Button>
              {actionInfo.value
                ? (
                  <Button
                    type="button"
                    onClick={handleFollowClick}
                    class="flex-1"
                  >
                    <Msg $key="remoteFollow.title" />
                  </Button>
                )
                : (
                  <Button
                    type="submit"
                    disabled={isLoading.value}
                    class="flex-1 disabled:opacity-50"
                  >
                    {isLoading.value
                      ? <Msg $key="remoteFollow.lookingUpUser" />
                      : <Msg $key="remoteFollow.lookupUser" />}
                  </Button>
                )}
            </div>
          </form>
        </div>
      </div>
    </TranslationSetup>
  );
}
