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
  const modalOpen = useSignal(false);

  const openModal = () => {
    modalOpen.value = true;
  };

  const closeModal = () => {
    modalOpen.value = false;
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
        open={modalOpen.value}
        onClose={closeModal}
        actorHandle={actorHandle}
        actorName={actorName}
        language={language}
      />
    </TranslationSetup>
  );
}
