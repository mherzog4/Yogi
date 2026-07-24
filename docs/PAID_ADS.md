# Paid acquisition operations

Yogi's paid-acquisition core prepares experiments and launch-ready plans. It
does not connect to an ad account, create campaigns, activate ads, or spend
money.

The first provider, account policy, currency, and test budget are tracked in
[issue #7](https://github.com/mherzog4/Yogi/issues/7).

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
plan is ready for a future adapter,” not “Yogi spent money.”
