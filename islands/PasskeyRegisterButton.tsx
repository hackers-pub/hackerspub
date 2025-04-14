import {
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import type { VerifiedRegistrationResponse } from "@simplewebauthn/server";
import { useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import getFixedT from "../i18n.ts";

export interface PasskeyRegisterButtonProps {
  language: Language;
  registrationOptionsUrl: string;
  verifyRegistrationUrl: string;
}

export function PasskeyRegisterButton(
  { language, registrationOptionsUrl, verifyRegistrationUrl }:
    PasskeyRegisterButtonProps,
) {
  const [name, setName] = useState("");
  const t = getFixedT(language);

  async function onClick() {
    if (name.trim() === "") {
      alert(t("settings.passkeys.nameRequired"));
      return;
    }
    const optionsResponse = await fetch(registrationOptionsUrl);
    const optionsJSON: PublicKeyCredentialCreationOptionsJSON =
      await optionsResponse.json();
    let registerResponse: RegistrationResponseJSON;
    try {
      registerResponse = await startRegistration({ optionsJSON });
    } catch (error) {
      alert(error);
      throw error;
    }
    const verificationResponse = await fetch(verifyRegistrationUrl, {
      method: "POST",
      body: JSON.stringify({
        name,
        registrationResponse: registerResponse,
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!verificationResponse.ok) {
      alert(t("settings.passkeys.registerFailed"));
      return;
    }
    const result: VerifiedRegistrationResponse = await verificationResponse
      .json();
    if (!result.verified) {
      alert(t("settings.passkeys.registerFailed"));
    }
    location.reload();
  }

  return (
    <TranslationSetup language={language}>
      <div class="mb-2">
        <Label label={t("settings.passkeys.name")}>
          <Input
            type="text"
            required
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </Label>
        <p class="opacity-50">
          <Msg $key="settings.passkeys.nameDescription" />
        </p>
      </div>
      <Button onClick={onClick}>
        <Msg $key="settings.passkeys.registerButton" />
      </Button>
    </TranslationSetup>
  );
}
