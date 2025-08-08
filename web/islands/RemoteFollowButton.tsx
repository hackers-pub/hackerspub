import { useSignal } from "@preact/signals";
import { Button } from "../components/Button.tsx";
import { Msg } from "../components/Msg.tsx";
import { RemoteFollowModal } from "./RemoteFollowModal.tsx";

export interface RemoteFollowButtonProps {
  actorHandle: string;
  actorName?: string;
}

export function RemoteFollowButton(
  { actorHandle, actorName }: RemoteFollowButtonProps,
) {
  const isModalOpen = useSignal(false);

  const openModal = () => {
    isModalOpen.value = true;
  };

  const closeModal = () => {
    isModalOpen.value = false;
  };

  return (
    <>
      <Button
        class="ml-4 mt-2 h-9"
        type="button"
        onClick={openModal}
      >
        <Msg $key="profile.follow" />
      </Button>

      <RemoteFollowModal
        isOpen={isModalOpen.value}
        onClose={closeModal}
        actorHandle={actorHandle}
        actorName={actorName}
      />
    </>
  );
}
