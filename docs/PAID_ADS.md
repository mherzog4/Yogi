# Paid acquisition operations

Yogi connects to Google Ads, LinkedIn Ads, TikTok Ads, and Meta Ads. It creates
the smallest safe remote structure supported across providers: a paused
campaign shell with reviewed budget values and enough metadata for subsequent
creative and targeting completion.

Campaign creation, activation, pausing, and daily metric polling are live
provider operations. Yogi does not invent targeting, upload generated creative
without provider-specific review, or silently activate spend.

## Configure hard ceilings

Add an approved policy to `yogi.config.ts`:

```ts
paidAds: {
  currency: "USD",
  maxDailyBudgetMinor: 5000,
  maxExperimentBudgetMinor: 50000,
  maxSpendWithoutConversionMinor: 10000,
  minimumCreativeVariants: 3,
  allowedLandingPageHosts: ["launch.example.com"],
  prohibitedPhrases: ["guaranteed results"],
},
```

All money values use integer minor units: `5000` means USD 50.00 when the
currency is USD. Yogi never converts currencies.

Landing-page hosts are exact, lowercase hostnames without a scheme or path. A
subdomain must be listed separately.

## Create an experiment

```bash
yogi campaign create paid-ads \
  --name "Launch Ads" \
  --goal "Generate qualified launch-plan signups"

yogi ads experiment create launch-ads \
  --name "Search intent test" \
  --objective "Generate qualified signups" \
  --hypothesis "Specific planning language attracts higher-intent founders" \
  --channel search \
  --landing-page https://launch.example.com/plan \
  --conversion launch_plan_started \
  --utm-source search \
  --utm-medium paid \
  --utm-campaign search-intent-test \
  --daily-budget-minor 3000 \
  --total-budget-minor 30000 \
  --stop-loss-minor 10000
```

Channel types are `search`, `social`, and `display`. They describe creative and
planning intent; they are not provider adapters.

Draft experiments may exceed configured ceilings so teams can review a larger
proposal. Such an experiment cannot pass launch readiness.

The experiment stop-loss is the maximum spend allowed without the named
conversion. It must not exceed either the workspace stop-loss ceiling or the
experiment's total budget.

## Generate and review creative

```bash
yogi ads creative prompt launch-ads search-intent-test
```

The prompt asks an agent for a JSON creative set at:

```text
campaigns/launch-ads/paid/creative/search-intent-test.json
```

Review a generated or hand-written set:

```bash
yogi ads review launch-ads search-intent-test creative.json
```

Review checks:

1. currency and budget ceilings;
2. daily budget versus total budget;
3. experiment stop-loss;
4. HTTPS and exact landing-page host;
5. a named conversion event and complete UTM source, medium, and campaign;
6. minimum creative count;
7. empty or duplicate variants;
8. product voice and paid-specific prohibited phrases.

The reviewed creative is copied to the canonical campaign path and its SHA-256
hash is recorded in the readiness report.

## Create a plan

A draft plan requires no approval:

```bash
yogi ads plan launch-ads search-intent-test
```

A launch-ready plan requires explicit approval:

```bash
yogi ads plan launch-ads search-intent-test --mode launch --approved
```

At launch-plan time, Yogi reruns review against the canonical creative and
current configuration. Tightened ceilings or edited creative therefore
invalidate an earlier pass.

Every plan records `externalActionPerformed: false`. The approval means “this
plan is ready,” not “Yogi spent money.”

## Connect an ad account

Every paid connection needs an account ID and a secret reference. Verify the
connection before publishing so Yogi records the account currency and refuses
currency-mismatched experiments.

```bash
yogi integrations connect tiktok-ads \
  --name "Founder TikTok" \
  --secret-ref env:TIKTOK_ADS_ACCESS_TOKEN \
  --account 123456789

yogi integrations verify <connection-id>
yogi integrations accounts <connection-id>
```

Provider-specific connection requirements:

| Provider     | Secret value                                 | Additional settings                                                |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| Google Ads   | JSON with `accessToken` and `developerToken` | account, optional manager account, explicit EU political-ad choice |
| LinkedIn Ads | OAuth bearer access token                    | account                                                            |
| TikTok Ads   | access token                                 | advertiser account                                                 |
| Meta Ads     | access token                                 | account and at least one ISO-2 target country                      |

See [INTEGRATIONS.md](INTEGRATIONS.md) for complete examples and API-version
pins.

## Publish a paused provider draft

Publishing reruns creative and policy review, verifies account/currency
matching, and requires a named approval:

```bash
yogi ads publish launch-ads search-intent-test \
  --connection <connection-id> \
  --approved-by "Matthew"
```

Yogi records one mapping per experiment, so several experiments under
`launch-ads` remain isolated. Replaying identical input returns the recorded
remote draft. Editing creative, budgets, account, or policy after publishing
requires a new reviewed experiment rather than mutating the recorded request.

Provider behavior:

- Google creates a non-shared daily budget and paused Search or Display
  campaign.
- LinkedIn creates a `DRAFT` campaign group with a total budget.
- TikTok creates a disabled Traffic campaign with a daily budget.
- Meta creates a paused Traffic campaign and paused, country-targeted ad set
  with a daily budget.

All four mark creative upload as still required.

## Activate, pause, and synchronize

Activation has a separate approval:

```bash
yogi ads activate launch-ads search-intent-test \
  --connection <connection-id> \
  --approved-by "Matthew"
```

Pause is a safety action and does not require approval:

```bash
yogi ads pause launch-ads search-intent-test \
  --connection <connection-id>
```

Poll daily metrics into private SQLite:

```bash
yogi ads sync launch-ads search-intent-test \
  --connection <connection-id> \
  --since 2026-07-01
```

Yogi normalizes impressions, clicks, spend in integer minor units,
conversions, date, and currency. If an active campaign reaches its total budget
or reaches its stop-loss with zero conversions, synchronization records an
idempotent safety operation and pauses the provider campaign automatically.

Provider dashboards remain the final review surface for targeting, asset
compatibility, policy review status, billing, and the exact objects eligible
to serve.
