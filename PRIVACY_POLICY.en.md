# Hackers' Pub Privacy Policy

*Last updated: April 3, 2026*

## 1. Introduction

Hackers' Pub is an invite-only social network for software engineers and
technology enthusiasts, built on the [ActivityPub] federated protocol. This
privacy policy explains what personal data we collect, how we use it, and your
rights regarding your data.

[ActivityPub]: https://www.w3.org/TR/activitypub/

## 2. Information We Collect

### Account Information

When you create an account, we collect:

- **Username**: your unique handle on Hackers' Pub
- **Display name** (optional)
- **Biography** (optional)
- **Profile picture (avatar)** (optional)
- **Header image** (optional)
- **Language preferences**
- **Email address**: required for sign-in; you may optionally make it visible on
  your public profile

### Authentication

- **Passkeys**: We store the public key material of your [WebAuthn] credentials,
  along with device type, backup status, and transports. Your private keys never
  leave your device and are never transmitted to or stored on our servers.
- **Sign-in tokens**: Temporary one-time verification codes used during the
  sign-in process, which expire automatically after 12 hours.

[WebAuthn]: https://www.w3.org/TR/webauthn/

### Session Data

Each time you sign in, we record:

- **IP address**
- **Browser or application name (user agent)**
- **Session creation timestamp**

Sessions expire automatically after 24 hours. IP address information is not
retained beyond that window.

### Content You Post

- **Posts**: Notes and articles you publish, including their content, visibility
  level (public, unlisted, followers-only, or direct), and timestamps.
- **Media attachments**: Images and other media you attach to posts, including
  any alt text you provide.
- **Edit history**: Revisions to articles you have edited.
- **Reactions and poll votes**: Your emoji reactions to posts and your votes on
  polls.

### Social Connections

- **Following and follower relationships**
- **Blocked accounts**
- **Pinned posts**
- **Mentions** in posts

### External Profile Links

Links to external services (such as GitHub, Mastodon, or personal websites)
that you choose to add to your profile, along with their cryptographic
verification status.

### Push Notifications (iOS)

If you enable push notifications on an iOS device, we store your **Apple Push
Notification Service (APNS) device token** in order to deliver notifications to
your device.

### Invitation Data

We record which account invited you to Hackers' Pub, and we track the
invitation links you create and how many times they have been used.

## 3. How We Use Your Information

We use the collected information to:

- Provide, operate, and improve Hackers' Pub
- Federate your public content with other ActivityPub-compatible servers (the
  Fediverse)
- Send email and in-app notifications about interactions with your posts and
  account
- Deliver push notifications to your devices (if enabled)
- Detect and prevent abuse, spam, and ban evasion
- Respond to your support and privacy requests

## 4. Information Sharing and Federation

### ActivityPub Federation

Hackers' Pub is part of the Fediverse, a network of federated social servers.
Your **public** and **unlisted** posts, profile information, and social graph
(following/follower lists) are shared with other servers in the Fediverse as
part of normal operation. Once content has been federated to another server,
it is beyond our control and subject to the privacy policies of those servers.

**Followers-only** and **direct** posts are delivered only to their intended
recipients, but they are transmitted to the servers those recipients are on.

### No Sale of Data

We do not sell, trade, or rent your personal information to third parties.

### Third-Party Applications

If you authorize third-party applications via OAuth, they receive access only to
the specific data you explicitly grant permission for. They never receive your
passkeys or email address through this mechanism.

## 5. Data Retention

| Data | Retained for |
|------|-------------|
| Sessions (IP address, user agent) | 24 hours (automatic expiry) |
| Sign-in tokens | 12 hours (automatic expiry) |
| Server logs | No more than 90 days |
| Account data and posts | Until you delete them or your account |
| APNS device tokens | Until you revoke push notifications or delete your account |

## 6. Data Security

We protect your data using:

- **HTTPS/TLS encryption** for all data in transit between your browser and our
  servers
- **Passkey-based authentication**: your credentials (private keys) never leave
  your device in any form

## 7. Your Rights

You have the right to:

- **Access**: Request a copy of the personal data we hold about you
- **Deletion**: Delete individual posts, or permanently delete your entire
  account and all associated data
- **Correction**: Update your profile information at any time through your
  account settings
- **Portability**: Export your posts and account data via your account settings
- **Objection**: Contact us to raise concerns about how we process your data

## 8. Cookies

We use session cookies solely to keep you signed in to Hackers' Pub. These
cookies are strictly necessary for the service to function and are not used for
advertising or cross-site tracking.

## 9. Children's Privacy

Hackers' Pub is not intended for children under 13 years of age (or under 16
in the EU/EEA). We do not knowingly collect personal information from children.
If you believe a child has provided us with personal data, please contact us and
we will delete it.

## 10. Contact

For privacy-related questions or requests, please contact us at:

**<privacy@hackers.pub>**

Or reach out to the site administrator at [@hongminhee@hackers.pub].

[@hongminhee@hackers.pub]: https://hackers.pub/@hongminhee
