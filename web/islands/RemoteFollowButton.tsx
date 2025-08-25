import { useSignal } from "@preact/signals";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import { RemoteFollowModal } from "./RemoteFollowModal.tsx";

export interface RemoteFollowButtonProps {
  actorHandle: string;
  actorName?: string;
  language: Language;
}

export function RemoteFollowButton(
  { actorHandle, actorName, language }: RemoteFollowButtonProps,
) {
  const isModalOpen = useSignal(false);

  const openModal = () => {
    isModalOpen.value = true;
  };

  const closeModal = () => {
    isModalOpen.value = false;
  };

  return (
    <TranslationSetup language={language}>
      <Button
        class="ml-4 mt-2 h-9"
        type="button"
        onClick={openModal}
      >
        <Msg $key="remoteFollow.title" />
      </Button>

      <RemoteFollowModal
        isOpen={isModalOpen.value}
        onClose={closeModal}
        actorHandle={actorHandle}
        actorName={actorName}
        language={language}
      />
    </TranslationSetup>
  );
}
