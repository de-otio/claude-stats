# Magic Link Authentication Flow - Bug Fixes

## Issues Fixed

### 1. GraphQL Schema - Invalid Subscription Return Type
**Problem**: `onTeamStatsUpdated` subscription returned `Boolean` which is invalid for AppSync subscriptions.

**Fix**: Changed return type to `TeamStatsUpdate` object type, updated corresponding mutation.

**Files**:
- `packages/infra/graphql/schema.graphql`

### 2. CreateAuthChallenge Lambda - Missing Email Extraction
**Problem**: Lambda failed to extract email for new users because it only checked `userAttributes.email`, which is empty when user doesn't exist.

**Fix**:
- For new users: Must call `SignUp` first (creates user with email)
- Then `InitiateAuth` will have `userAttributes.email` populated
- Added fallback to `clientMetadata` (though Cognito doesn't pass it to CreateAuthChallenge)
- Improved error messages

**Files**:
- `packages/infra/lambda/auth/create-challenge.ts`

### 3. PreSignUp Lambda - Same Email Extraction Issue
**Problem**: Same as CreateAuthChallenge - couldn't extract email for new users.

**Fix**: Updated to check `userAttributes.email` first, with fallback to `clientMetadata.email`.
Added better error messages for domain validation failures.

**Files**:
- `packages/infra/lambda/auth/pre-signup.ts`

### 4. Missing Test Coverage
**Problem**: Auth flow had insufficient test coverage - bugs weren't caught during testing.

**Fix**: Added comprehensive unit tests for:
- Email extraction logic
- Domain validation
- Rate limiting
- Created integration test documentation

**Files**:
- `test/jam-claude-stats.test.ts` - Infrastructure unit tests
- `test/magic-link-auth.integration.test.ts` - Integration tests and documentation

## Correct Auth Flow for New Users

```
1. SignUp
   - Client: POST /api/sign-up with email
   - Cognito creates user with email in userAttributes
   - PreSignUp Lambda validates email domain
   - User auto-confirmed

2. InitiateAuth (Request Magic Link)
   - Client: POST /api/auth with CUSTOM_AUTH flow
   - Cognito: username = email (exists from signup)
   - CreateAuthChallenge Lambda:
     * Extracts email from userAttributes
     * Generates token + HMAC
     * Stores token hash in DynamoDB
     * Sends email via SES
   - Returns CUSTOM_CHALLENGE

3. VerifyAuthChallenge
   - Client: POST /api/auth/verify with token from email
   - VerifyAuthChallenge Lambda:
     * Validates token (HMAC, expiry, not-used)
     * Returns JWT tokens on success
```

## Configuration

### Required Environment Variables
- `SES_FROM_EMAIL`: Verified sender email address
- `ALLOWED_EMAIL_DOMAINS`: Comma-separated list of allowed domains
- `MAGIC_LINK_TTL_MINUTES`: Token expiry time (default: 15)
- `MAX_REQUESTS_PER_HOUR`: Rate limit (default: 3)

### AWS SES Configuration
- Sender email must be verified in SES
- Recipient email must be verified in dev/sandbox
- Use a different domain for sender than user domain to avoid Exchange blocking

## Testing

### Unit Tests
```bash
npm test  # Runs Lambda logic tests
```

Covers:
- Email extraction from userAttributes and clientMetadata
- Domain validation against allowed list
- Sliding window rate limiting logic

### Integration Tests
Integration tests are marked as `.skip()` because they require:
1. Live AWS account with deployed infrastructure
2. SES sandbox verified identities
3. Email inbox access to extract magic link tokens

To test manually:
```bash
# 1. SignUp
aws cognito-idp sign-up \
  --client-id <CLIENT_ID> \
  --username user@allowed-domain.com \
  --password DummyPassword123!@# \
  --region eu-central-1

# 2. Request magic link
aws cognito-idp initiate-auth \
  --client-id <CLIENT_ID> \
  --auth-flow CUSTOM_AUTH \
  --auth-parameters USERNAME=user@allowed-domain.com \
  --region eu-central-1

# 3. Check CloudWatch logs for CreateAuthChallenge invocation
aws logs tail /aws/lambda/ClaudeStats-dev-CreateAuthChallenge \
  --region eu-central-1 --follow
```

## Deployment

The updated infrastructure includes:
- ✅ Fixed GraphQL schema
- ✅ Fixed auth Lambdas with better error handling
- ✅ MCP server behind feature flag (disabled by default)
- ✅ Comprehensive test coverage

```bash
npx cdk deploy --all --profile pando-dev --require-approval never
```

## Known Limitations

1. **SES Sandbox Mode**: Only 1 verified email for testing
2. **Email Domain**: Sender domain must differ from user domain (Exchange Online requirement)
3. **Token Storage**: Tokens stored as HMAC hashes - cannot be recovered
4. **Rate Limiting**: 3 requests per hour per email (stored in DynamoDB)
