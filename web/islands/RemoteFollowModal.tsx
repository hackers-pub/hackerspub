import { useSignal } from "@preact/signals";
import { Button } from "../components/Button.tsx";

export interface RemoteFollowModalProps {
  isOpen: boolean;
  onClose: () => void;
  actorHandle: string;
  actorName?: string;
}

export function RemoteFollowModal(
  { isOpen, onClose, actorHandle, actorName }: RemoteFollowModalProps,
) {
  const fediverseId = useSignal("");
  const errorMessage = useSignal("");

  const validateFediverseId = (id: string): boolean => {
    // Fediverse ID 형식: @username@domain.com 또는 username@domain.com
    const fediverseIdRegex =
      /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
    return fediverseIdRegex.test(id.trim());
  };

  const isHackersPubUser = (id: string): boolean => {
    const normalizedId = id.trim().toLowerCase();
    const withoutAt = normalizedId.startsWith("@")
      ? normalizedId.slice(1)
      : normalizedId;
    return withoutAt.endsWith("@hackerspub.com");
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    const inputId = fediverseId.value.trim();
    if (!inputId) {
      errorMessage.value = "Fediverse ID를 입력해주세요.";
      return;
    }

    // Fediverse ID 형식 검증
    if (!validateFediverseId(inputId)) {
      errorMessage.value =
        "올바른 Fediverse ID 형식이 아닙니다. (@username@domain.com 형식으로 입력해주세요)";
      return;
    }

    // 해커스펍 사용자인지 확인
    if (isHackersPubUser(inputId)) {
      const shouldRedirectToLogin = confirm(
        "해커스펍 사용자로 보입니다. 로그인하시겠습니까?\n" +
          "확인: 로그인 페이지로 이동\n" +
          "취소: 모달 닫기",
      );

      if (shouldRedirectToLogin) {
        // 현재 페이지를 returnUrl로 설정하여 로그인 페이지로 이동
        const returnUrl = encodeURIComponent(window.location.href);
        window.location.href = `/sign?returnUrl=${returnUrl}`;
      } else {
        onClose();
      }
      return;
    }

    // 일반 Fediverse 사용자: 원격 팔로우 처리
    try {
      const normalizedId = inputId.startsWith("@") ? inputId.slice(1) : inputId;
      const [_, domain] = normalizedId.split("@");

      // 원격 팔로우를 위한 URL 생성 (ActivityPub 표준)
      const followUrl = `https://${domain}/authorize_interaction?uri=${
        encodeURIComponent(actorHandle)
      }`;
      window.open(followUrl, "_blank");
      onClose();
    } catch (error) {
      console.error("Remote follow error:", error);
      errorMessage.value = "원격 팔로우 처리 중 오류가 발생했습니다.";
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
    // 입력 중일 때 에러 메시지 초기화
    if (errorMessage.value) {
      errorMessage.value = "";
    }
  };

  if (!isOpen) return null;

  return (
    <div
      class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={handleBackdropClick}
    >
      <div class="bg-white dark:bg-stone-800 rounded-lg p-6 max-w-md w-full mx-4">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-lg font-semibold">
            원격 팔로우
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
            {actorName || actorHandle}님을 팔로우하려면 Fediverse ID를
            입력해주세요.
          </p>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Fediverse ID를 입력하세요 (예: @username@mastodon.social)
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="mb-4">
            <label
              htmlFor="fediverseId"
              class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2"
            >
              Fediverse ID
            </label>
            <input
              id="fediverseId"
              type="text"
              placeholder="@username@mastodon.social"
              value={fediverseId.value}
              onInput={handleInputChange}
              class={`w-full px-3 py-2 border rounded-md bg-white dark:bg-stone-700 text-gray-900 dark:text-gray-100 ${
                errorMessage.value
                  ? "border-red-500 dark:border-red-400"
                  : "border-gray-300 dark:border-gray-600"
              }`}
              required
            />
            {errorMessage.value && (
              <p class="text-red-500 text-xs mt-1">{errorMessage.value}</p>
            )}
          </div>

          <div class="flex gap-3">
            <Button
              type="button"
              onClick={onClose}
              class="flex-1 bg-gray-100 dark:bg-stone-700 hover:bg-gray-200 dark:hover:bg-stone-600"
            >
              취소
            </Button>
            <Button
              type="submit"
              class="flex-1"
            >
              팔로우
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
