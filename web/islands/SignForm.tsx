import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import type { VerifiedAuthenticationResponse } from "@simplewebauthn/server";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import getFixedT from "../i18n.ts";

export interface SignFormProps {
  language: Language;
  values?: {
    email?: string;
  };
  errors?: {
    email?: string;
  };
}

export function SignForm({ language, values, errors }: SignFormProps) {
  const t = getFixedT(language);
  const [sessionId, _] = useState(crypto.randomUUID());
  const [email, setEmail] = useState(values?.email);
  const [error, setError] = useState(errors?.email);

  useEffect(() => {
    fetch(`/sign/options?sessionId=${sessionId}`).then(
      async (optionsResponse) => {
        if (!optionsResponse.ok) {
          return;
        }
        const optionsJSON: PublicKeyCredentialRequestOptionsJSON =
          await optionsResponse.json();
        let authResponse: AuthenticationResponseJSON;
        try {
          authResponse = await startAuthentication({
            optionsJSON,
            useBrowserAutofill: true,
          });
        } catch {
          setError(t("signInUp.passkeyCanceled"));
          return;
        }
        const verifyResponse = await fetch(
          `/sign/verify?sessionId=${sessionId}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(authResponse),
          },
        );
        if (!verifyResponse.ok) {
          setError(t("signInUp.passkeyFailed"));
          return;
        }
        const result: VerifiedAuthenticationResponse = await verifyResponse
          .json();
        if (!result.verified) {
          setError(t("signInUp.passkeyFailed"));
          return;
        }
        location.href = "/";
      },
    );
  }, [sessionId]);

  return (
    <TranslationSetup language={language}>
      <form method="post">
        <Label label={t("signInUp.emailOrUsername")} class="grow">
          <Input
            type="text"
            name="email"
            class="lg:text-xl w-full"
            required
            aria-invalid={error ? true : false}
            value={email}
            autocomplete="username email webauthn"
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </Label>
        <Button type="submit" class="lg:text-xl mt-4">
          <Msg $key="signInUp.submit" />
        </Button>
      </form>
      <div class="prose dark:prose-invert mt-5">
        <p>
          {error ?? <Msg $key="signInUp.description" />}
        </p>
      </div>
    </TranslationSetup>
  );
}
