# 02 — Authentication

## Magic Link Flow

Passwordless authentication using Cognito Custom Auth Challenge.

### Flow

```
1. User enters email on login page
2. Frontend calls Cognito InitiateAuth (CUSTOM_AUTH)
3. DefineAuthChallenge Lambda → issues CUSTOM_CHALLENGE
4. CreateAuthChallenge Lambda:
   a. Checks per-email rate limit (max N per hour, from env config)
   b. If over limit → returns throttled error (no email sent)
   c. Invalidates any existing unused token for this email (overwrites DynamoDB item)
   d. Generates random token (UUID v4)
   e. Computes HMAC-SHA-256(token, per-environment-secret) and stores hash + expiry in DynamoDB
   f. Builds magic link URL: https://{domain}/auth/verify?email={email}&token={token}
   g. Sends HTML email via SES (token only in link href, not visible in body text)
5. User clicks link → frontend extracts email + token from URL params
6. Frontend calls RespondToAuthChallenge with the token
7. VerifyAuthChallengeResponse Lambda:
   a. Computes HMAC-SHA-256(token, secret) and looks up hash in DynamoDB
   b. Validates: hash matches, not expired, not already used
   c. Marks token as used (conditional write to prevent replay)
   d. Returns success → Cognito issues JWT tokens (access: 1h, refresh: 30d)
8. On failure: returns "Link expired or invalid" (no detail to prevent enumeration)
```

### Lambda Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `DefineAuthChallenge` | Cognito | Orchestrates challenge sequence; limits to 3 attempts per session |
| `CreateAuthChallenge` | Cognito | Rate-limits, generates token, sends email via SES |
| `VerifyAuthChallengeResponse` | Cognito | Validates token via HMAC, checks expiry, marks used |
| `PreSignUp` | Cognito | Enforces domain restriction, auto-confirms user |
| `PreTokenGeneration` | Cognito | Injects Cognito group claims (`cognito:groups`) into JWT |

### Token Security

- Tokens are UUID v4 (122 bits of entropy)
- Stored as HMAC-SHA-256 hash (keyed with per-environment secret from Secrets Manager — not plain SHA-256, which is vulnerable to rainbow tables if the DB leaks)
- TTL: 15 minutes in prod, configurable per environment (see [12-environments.md](12-environments.md))
- Single use: DynamoDB conditional write (`attribute_exists(tokenHash) AND used = false`) prevents replay
- One active link per email: new request overwrites previous token (PK=email, SK="TOKEN")
- Clock tolerance: 30-second grace period on expiry check to account for server clock skew

### Magic Link Email

The SES email template:
- **Subject:** "Sign in to Claude Stats"
- **Body:** HTML with a styled button linking to the verification URL
- **Token not shown in text** — only embedded in the button href, so email previews don't leak it
- **Plaintext fallback:** includes the full URL for email clients that strip HTML

## Domain-Restricted Signup

The `PreSignUp` Lambda enforces allowed email domains:

```typescript
// Allowed domains loaded from SSM Parameter Store at cold start
let ALLOWED_DOMAINS: string[];

export const handler = async (event: PreSignUpTriggerEvent) => {
  if (!ALLOWED_DOMAINS) {
    ALLOWED_DOMAINS = await loadFromSSM("/claude-stats/allowed-domains");
  }

  const email = event.request.userAttributes.email?.toLowerCase();
  if (!email) throw new Error("Email is required");

  const domain = email.split("@")[1];
  if (!ALLOWED_DOMAINS.includes(domain)) {
    throw new Error("Signup not allowed for this email domain");
    // Generic message — don't reveal which domains are allowed
  }

  // Auto-confirm email (magic link already verified the address)
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
```

Domain list is stored in SSM Parameter Store (updated by superadmins via the API, which writes to SSM). The Lambda caches the value and refreshes every 5 minutes.

### Email Uniqueness

Cognito User Pool is configured with `email` as a required, unique alias attribute. A second signup attempt with the same email returns "user already exists" — the user should use the login flow instead.

### Deprovisioned Users

If a user's email domain is removed from the allowed list:
- **Existing users can still log in** (domain check is only on signup)
- Superadmin can **disable the Cognito user** to revoke access entirely
- Disabled users receive "Account suspended" when requesting a magic link

## Abuse Protection

### Layer 1: AWS WAF

WAF WebACL attached to both Cognito User Pool **and** AppSync API:

| Rule | Action | Threshold |
|------|--------|-----------|
| Rate limit on `SignUp` | Block | 5 requests per IP per 5 min |
| Rate limit on `InitiateAuth` | Block | 10 requests per IP per 5 min |
| Rate limit on `RespondToAuthChallenge` | CAPTCHA | 20 requests per IP per 5 min |
| Rate limit on `joinTeam` | Block | 10 requests per IP per 5 min (invite code brute-force) |
| AWS Managed Rules (IP reputation) | Block | N/A |
| AWS Managed Rules (known bots) | Block | N/A |
| Geo-restriction (optional) | Block | Configurable per environment |

### Layer 2: Cognito Advanced Security (Prod Only)

- **Compromised credentials detection** — checks against known breach databases
- **Adaptive authentication** — risk-based step-up (adds CAPTCHA for suspicious patterns)
- **Account takeover protection** — anomaly detection on sign-in patterns; triggers email notification to user
- **Recovery:** user requests a new magic link; if account is locked, superadmin can unlock via Cognito console or admin API

### Layer 3: Application-Level

- Magic link tokens expire after 15 minutes (prod) / 60 minutes (dev)
- Max requests per email per hour: 3 (prod) / 20 (dev) — enforced in CreateAuthChallenge Lambda via DynamoDB atomic counter
- When limit exceeded: returns generic "Please try again later" (no rate limit detail leaked)
- Failed verification attempts logged to CloudWatch with email hash (not plaintext) for monitoring
- Cognito User Pool has no password policy (passwordless only — `ALLOW_CUSTOM_AUTH` flow only, `ALLOW_USER_PASSWORD_AUTH` disabled)

## Token Storage (DynamoDB)

```
Table: MagicLinkTokens
PK: email (lowercase, trimmed)
SK: "TOKEN"
Attributes:
  tokenHash: string             (HMAC-SHA-256 of token)
  expiresAt: number             (epoch seconds — DynamoDB TTL attribute)
  used: boolean
  createdAt: number
  requestCount: number          (rate limiting counter)
  requestWindowStart: number    (epoch seconds — resets hourly)
```

TTL attribute on `expiresAt` ensures automatic cleanup of expired tokens. Used tokens are cleaned up within ~48 hours by DynamoDB TTL.

## HMAC Secret Rotation

The magic link HMAC secret is auto-rotated every 90 days via Secrets Manager. To avoid rejecting valid tokens during rotation:

1. Secrets Manager maintains a **current** and **previous** secret version (`AWSCURRENT` and `AWSPREVIOUS`)
2. The `VerifyAuthChallengeResponse` Lambda loads both versions at cold start (cached for 5 minutes)
3. On verification, it checks the token hash against `AWSCURRENT` first, then falls back to `AWSPREVIOUS`
4. The `CreateAuthChallenge` Lambda always signs with `AWSCURRENT`
5. Since magic link TTL is 15 minutes (prod), and the dual-key window lasts until the next rotation, there is no risk of rejecting a valid token during rotation

## JWT Configuration

| Token | TTL | Notes |
|-------|-----|-------|
| Access token | 1 hour | Short-lived; carries group claims |
| ID token | 1 hour | Contains user attributes |
| Refresh token | 30 days | Used by SPA for silent refresh |

The SPA uses Amplify's built-in token refresh: when an access token expires, Amplify automatically uses the refresh token to obtain new access/ID tokens without user interaction.
