# Outbound email operations

Yogi prepares safe, provider-neutral prospect batches and can publish them as
paused campaigns in Smartlead, Instantly, or EmailBison. Activation is always a
separate approved operation.

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
batch for publishing to a paused provider campaign.

## Connect an email provider

Store the credential in the exe.dev VM environment or your local shell. Yogi
stores only the environment-variable reference:

```bash
export INSTANTLY_API_KEY="..."

yogi integrations connect instantly \
  --name "Founder outbound" \
  --secret-ref env:INSTANTLY_API_KEY

yogi integrations verify <connection-id>
yogi integrations accounts <connection-id>
```

Use `smartlead`, `instantly`, or `emailbison` as the provider ID. A dedicated or
white-label EmailBison installation can set its HTTPS origin:

```bash
yogi integrations connect emailbison \
  --name "Agency workspace" \
  --secret-ref env:EMAILBISON_API_KEY \
  --base-url https://mail.example.com
```

## Publish, review, and activate

First publish the approved batch as a paused remote campaign:

```bash
yogi outbound publish founder-launch <batch-id> \
  --connection <connection-id> \
  --name "Founder launch" \
  --subject "A distribution idea" \
  --body-file campaigns/founder-launch/sequence.md \
  --sender <sender-account-id> \
  --approved-by "Matthew" \
  --timezone America/New_York \
  --weekdays 1,2,3,4,5 \
  --start 09:00 \
  --end 17:00
```

Repeat `--sender` to rotate multiple mailboxes. Publishing configures the
sequence and schedule, uploads the selected prospects, and records the provider
campaign mapping in SQLite. It does not activate sending.

Review the rendered sequence, sender health, schedule, suppressions, and
provider-side lead count in the provider UI. Then activate:

```bash
yogi outbound activate founder-launch \
  --connection <connection-id> \
  --approved-by "Matthew"
```

Pause is explicit but does not need an approval because it reduces sending:

```bash
yogi outbound pause founder-launch --connection <connection-id>
```

Poll delivery and engagement events into private SQLite:

```bash
yogi outbound sync founder-launch --connection <connection-id>
```

Yogi stores normalized `sent`, `opened`, `clicked`, `replied`, `bounced`, and
`unsubscribed` events. Contact identity is represented by a SHA-256 email hash
when the provider exposes an address; raw provider payloads and email addresses
are not copied into the event ledger. A provider event ID is inserted once,
and the polling cursor advances only after the batch is safely stored.

Smartlead sender IDs and EmailBison sender IDs are numeric. Instantly uses the
sender email address as its account ID. The account-discovery command prints
the exact value to pass.

## Exclusion order

Yogi applies exclusions deterministically:

1. non-prospect status;
2. suppressed email;
3. suppressed domain;
4. role-based address;
5. missing personalization;
6. per-domain limit;
7. daily prospect limit.

Provider adapters preserve provider-side duplicate and suppression checks, use
the Yogi daily prospect cap, and stop on replies where supported. Yogi's
approval flag is not a substitute for applicable law, provider policy,
deliverability review, or operator judgment.

Suppressions are workspace-global: an email or domain suppressed while working
on one campaign is excluded from every campaign in the same workspace.
