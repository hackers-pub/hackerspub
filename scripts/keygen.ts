import { exportJwk, generateCryptoKeyPair } from "@fedify/fedify";

const keyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
const jwk = await exportJwk(keyPair.privateKey);
console.log(JSON.stringify(jwk));
