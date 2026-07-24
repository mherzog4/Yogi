# Outbound email operations

Yogi's outbound core prepares safe, provider-neutral prospect batches. It does
not send email.

The sending-provider decision is tracked in
[issue #3](https://github.com/mherzog4/Yogi/issues/3).

## Data boundary

Contact-level data is operational data and should not be committed to Git.

| Data                                | Location                                     | Versioned |
| ----------------------------------- | -------------------------------------------- | --------- |
| Prospect emails and personalization | `.yogi/private/.../prospects.json`           | No        |
| Workspace-global suppressions       | `.yogi/private/outbound/suppressions.json`   | No        |
| Full draft/send-ready batches       | `.yogi/private/.../batches/`                 | No        |
| Import counts and source hash       | `campaigns/<id>/outbound/import-report.json` | Yes       |
| Batch counts, policy, exclusions    | `campaigns/<id>/outbound/batch-summaries/`   | Yes       |

Yogi records rejected CSV row numbers and reason codes, not rejected email
values. The original CSV is not moved or deleted; keep it outside the
repository or under an ignored directory such as `.yogi/imports/`.

## Configure safety limits

Edit the outbound block in `yogi.config.ts`:

```ts
outbound: {
  dailyProspectLimit: 20,
  maxPerDomain: 2,
  requirePersonalization: true,
  allowRoleBasedAddresses: false,
},
```

These conservative defaults limit concentration, require a concrete
personalization observation, and exclude generic addresses such as `info@` and
`sales@`.

## CSV format

Required columns:

- `email`
- `company`
- `source`

Optional columns:

- `first_name`
- `last_name`
- `role`
- `source_url`
- `personalization`
- `status`: `prospect`, `contacted`, `replied`, `unsubscribed`, or `bounced`

See [examples/prospects.csv](../examples/prospects.csv).

Yogi normalizes email case, derives domains, validates required values, and
deduplicates by email. The import report contains aggregate rejection reasons.

## Workflow

```bash
yogi outbound import founder-launch .yogi/imports/prospects.csv

yogi outbound suppress founder-launch customer.example \
  --type domain \
  --reason "Existing customer"

yogi outbound plan founder-launch
```

The default `draft` plan requires no approval and produces no external action.
A send-ready plan requires an explicit flag:

```bash
yogi outbound plan founder-launch --mode send --approved
```

Even a send-ready plan does not send email. It freezes the approved private
batch for the future provider adapter.

## Exclusion order

Yogi applies exclusions deterministically:

1. non-prospect status;
2. suppressed email;
3. suppressed domain;
4. role-based address;
5. missing personalization;
6. per-domain limit;
7. daily prospect limit.

Provider adapters must apply their own mailbox limits, unsubscribe handling,
and provider-side suppression before sending. Yogi's approval flag is not a
substitute for applicable law, provider policy, or operator review.

Suppressions are workspace-global: an email or domain suppressed while working
on one campaign is excluded from every campaign in the same workspace.
