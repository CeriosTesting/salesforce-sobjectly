# Integration tests

The tests in `tests/integration` run the client against a real Salesforce org. They create and delete records, and the first run deploys a few test fixtures. Use a free Developer Edition org or a sandbox. **Never point them at production.**

The unit tests (`npm test`) need none of this.

In short:

1. [Install Node.js and the Salesforce CLI](#1-install-the-tools).
2. [Create a Developer Edition org](#2-create-a-developer-edition-org).
3. [Choose a login and fill in `.env`](#3-choose-a-login).
4. [Run `npm run test:integration`](#4-run-the-tests).

## 1. Install the tools

- **Node.js 24** (see `.nvmrc`). Install the dependencies in the repository root:

  ```bash
  npm install
  ```

- **Salesforce CLI** (`sf`). You need it for the recommended login and to get access tokens:

  ```bash
  npm install --global @salesforce/cli
  sf --version
  ```

  On Windows, open a new terminal after installing so `sf` is on the `PATH`.

## 2. Create a Developer Edition org

1. Sign up at <https://developer.salesforce.com/signup>.
2. Open the verification email and set your password.
3. Look up your **My Domain URL** in Setup → **My Domain**. It looks like `https://<name>-dev-ed.develop.my.salesforce.com`.

You are the System Administrator of the new org. That user has every permission the tests need: API access and deploying Apex and metadata.

A sandbox works too. Log in with its My Domain URL or `https://test.salesforce.com`.

## 3. Choose a login

The settings live in `.env` in the repository root. Create it from the template:

```bash
cp .env.example .env                # PowerShell: Copy-Item .env.example .env
```

`.env` is gitignored. Never commit it. In CI, set the same variables in the environment instead.

Every setup needs `SF_API_VERSION` plus **one** login:

| Login                                          | Best for              | Expires?                                             | Needs                     |
| ---------------------------------------------- | --------------------- | ---------------------------------------------------- | ------------------------- |
| [A. Salesforce CLI](#a-salesforce-cli)         | Local development     | No, the CLI refreshes the token                      | Salesforce CLI            |
| [B. Client credentials](#b-client-credentials) | CI, long-lived setups | No, a new token is requested when needed             | An External Client App    |
| [C. Access token](#c-access-token)             | A quick one-off run   | Yes, when the session times out (2 hours by default) | Salesforce CLI to get one |

> [!IMPORTANT]
> The first complete login wins, in this order: client credentials, access token, `SF_TARGET_ORG`. Leave the variables of the logins you don't use empty. An expired `SF_ACCESS_TOKEN` takes priority over a working `SF_TARGET_ORG`, and every test then fails with `INVALID_SESSION_ID`.

**API version.** Set `SF_API_VERSION` to a version your org supports, e.g. `v67.0` (`67.0` works too). `sf org display --target-org <alias>` shows the org's latest version as **Api Version**.

### A. Salesforce CLI

Recommended for local development. You need no app and no secrets.

1. Log in once. A browser window opens:

   ```bash
   sf org login web --alias salesforce-dev --instance-url https://<your-my-domain>.my.salesforce.com
   ```

2. Check the login. **Connected Status** should be `Connected`:

   ```bash
   sf org display --target-org salesforce-dev
   ```

3. Fill in `.env`:

   ```ini
   SF_API_VERSION=v67.0
   SF_TARGET_ORG=salesforce-dev
   ```

The tests ask the CLI for a token (`sf org auth show-access-token`), and the CLI refreshes it when it expires. If the CLI login itself expires, run step 1 again.

### B. Client credentials

Recommended for CI. The tests log in with the OAuth 2.0 client credentials flow of an External Client App and run as the user you pick.

1. In Setup, open **External Client App Manager** and click **New External Client App**.
2. Enter a name and contact email. Under **API (Enable OAuth Settings)**:
   - tick **Enable OAuth**;
   - enter a callback URL, e.g. `http://localhost:1717/OauthRedirect` (the flow doesn't use it, but the field is required);
   - add the OAuth scope **Manage user data via APIs (api)**;
   - tick **Enable Client Credentials Flow**.

   Then save.

3. On the app's **Policies** tab, click **Edit**. Under OAuth Policies, tick **Enable Client Credentials Flow** and set **Run As** to your own user or an integration user with API access. Save.
4. On the **Settings** tab, open **OAuth Settings** and click **Consumer Key and Secret**. Salesforce first emails you a verification code.
5. Fill in `.env`:

   ```ini
   SF_API_VERSION=v67.0
   SF_LOGIN_URL=https://<your-my-domain>.my.salesforce.com
   SF_CLIENT_ID=<consumer key>
   SF_CLIENT_SECRET=<consumer secret>
   ```

   `SF_LOGIN_URL` must be your My Domain URL. `login.salesforce.com` doesn't support this flow.

A new app can take a few minutes before Salesforce accepts it.

### C. Access token

Quick, but it expires.

1. Get a token, and the instance URL (shown as **Instance Url**):

   ```bash
   sf org auth show-access-token --target-org salesforce-dev --json
   sf org display --target-org salesforce-dev
   ```

   Since May 2026, `sf org display` no longer prints tokens.

2. Fill in `.env`:

   ```ini
   SF_API_VERSION=v67.0
   SF_ACCESS_TOKEN=<token>
   SF_INSTANCE_URL=https://<your-my-domain>.my.salesforce.com
   ```

The token stops working when the session times out, and the tests then fail with `INVALID_SESSION_ID`. Get a new token, or switch to login A. To make tokens last longer, raise the timeout in Setup → **Session Settings** (24 hours at most).

### Testing the CLI login as well

If `SF_TARGET_ORG` is set next to login B or C, `auth.test.ts` also logs in through the CLI and checks that it reaches the same org. Otherwise that test is skipped.

## 4. Run the tests

```bash
npm run test:integration
```

- The test files run one after another, because they share the org. A single test may take up to 2 minutes.
- If every test is skipped, the configuration is incomplete. Check `SF_API_VERSION` and the login variables.
- To run one file:

  ```bash
  npx vitest --run --config vitest.integration.config.mts tests/integration/query.test.ts
  ```

## What the tests do in your org

**Records.** The tests create Accounts, Contacts and files whose names start with `sobjectly-it-<timestamp>`, and delete them when a test file finishes. An aborted run can leave some behind. To find them:

```bash
sf data query --target-org salesforce-dev --query "SELECT Id, Name FROM Account WHERE Name LIKE 'sobjectly-it-%'"
sf data query --target-org salesforce-dev --query "SELECT Id, LastName FROM Contact WHERE LastName LIKE 'sobjectly-it-%'"
```

**Fixtures.** The first run deploys these and keeps them for later runs (see `fixtures.ts`):

| Fixture                   | What it is                                    | Tests             |
| ------------------------- | --------------------------------------------- | ----------------- |
| `Sobjectly_Test__e`       | Platform event with a `Message__c` text field | Publishing events |
| `SobjectlyEcho`           | Apex REST resource at `/sobjectly/echo/*`     | Apex REST calls   |
| `SobjectlyDouble`         | Invocable Apex class                          | Invocable actions |
| `Sobjectly_Test_Accounts` | Summary report on Accounts, grouped by Type   | The Reports API   |

They are only created in Developer Edition orgs, scratch orgs and sandboxes. In any other org, set `SF_IT_SETUP=1` to allow it. Without it, the tests that need the fixtures are skipped. To remove the fixtures, delete them in Setup (Apex Classes, Platform Events) and in the Reports tab.

**Debug logs.** One test runs anonymous Apex and sets a temporary trace flag on your user to capture the debug log. The flag is removed afterwards.

**Limits.** A run uses some of the org's daily API requests and runs a few Bulk API 2.0 jobs.

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_SESSION_ID` or status 401         | `SF_ACCESS_TOKEN` has expired. Get a new one, or clear `SF_ACCESS_TOKEN` and `SF_INSTANCE_URL` so `SF_TARGET_ORG` is used.  |
| Every test is skipped                      | `SF_API_VERSION` is missing, or no login is complete.                                                                       |
| `sf` is not found                          | Install the Salesforce CLI and open a new terminal.                                                                         |
| The CLI says the org isn't logged in       | Log in again with `sf org login web` (login A, step 1).                                                                     |
| `request not supported on this domain`     | `SF_LOGIN_URL` isn't your My Domain URL.                                                                                    |
| `invalid_client_id` or `invalid_client`    | The consumer key or secret is wrong, or the app is new. Wait a few minutes and try again.                                   |
| `no client credentials user enabled`       | The app has no Run As user (login B, step 3).                                                                               |
| The "reads limits and versions" test fails | `SF_API_VERSION` is newer than your org supports.                                                                           |
| Deploying the fixtures fails               | Your user can't deploy Apex or metadata. Use a System Administrator, and check the component failures in the error message. |

## Rules

- Never commit `.env`, org credentials, org-specific data or types generated from a real org.
- Never run the tests against production.
