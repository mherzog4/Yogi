# Content operations

Yogi's content engine prepares grounded, reviewable assets. It does not publish
content.

The format and publishing-destination decision is tracked in
[issue #5](https://github.com/mherzog4/Yogi/issues/5).

## Source boundary

Every content brief must reference at least one source copied into the campaign:

```bash
yogi content source add founder-content notes.md \
  --title "Founder research" \
  --type customer-research \
  --deidentified
```

Source types are:

- `original`: product knowledge, an owned essay, or an internal point of view;
- `customer-research`: de-identified interviews, surveys, or support themes;
- `external`: a local text copy plus its required public `--url`.

Sources must be UTF-8 text. Yogi copies them under
`campaigns/<id>/content/sources/`, records their SHA-256 hashes, and versions
them in Git. Before prompt generation or editorial review, Yogi verifies that
each copy still matches its indexed hash. Do not import names, email addresses,
private transcripts, restricted documents, or material you do not have the
right to use.

`--deidentified` is an operator acknowledgement, not an automatic redaction
tool.

## Configure the editorial gate

Edit the content block in `yogi.config.ts`:

```ts
content: {
  editorialMinimumScore: 80,
  prohibitedPhrases: ["guaranteed", "best-in-class", "game-changing"],
},
```

The product voice's `avoid` phrases are also enforced.

## Create a grounded brief

```bash
yogi content brief create founder-content \
  --title "Why credible launches compound" \
  --thesis "Specific evidence earns trust" \
  --format article \
  --cta "Read the launch guide" \
  --source founder-research
```

Supported formats are `article`, `newsletter`, `linkedin-post`, `x-thread`,
and `video-script`. Use `--source` more than once when the brief depends on
multiple inputs.

Generate the prompt:

```bash
yogi content prompt founder-content why-credible-launches-compound
```

The prompt points the agent to the versioned source files. A drafted factual
claim should carry a nearby marker such as `[[source:founder-research]]`.

## Repurpose and review

```bash
yogi content repurpose founder-content why-credible-launches-compound \
  --format newsletter \
  --format linkedin-post \
  --format x-thread

yogi content review founder-content why-credible-launches-compound \
  campaigns/founder-content/content/drafts/why-credible-launches-compound.md
```

Repurpose plans preserve the core thesis while applying format-specific
guidance. Editorial review checks:

1. a descriptive H1;
2. format-specific minimum length;
3. one citation marker for every required source;
4. the exact call to action;
5. unresolved placeholders;
6. prohibited phrases and avoided voice language.

Errors always fail review. Warnings reduce the score, which must meet the
configured minimum. Reports are written under
`campaigns/<id>/content/reviews/`.

The checks make omissions visible; they do not prove that a claim is true,
that a citation supports it, or that publication is legally appropriate. Those
remain human-review responsibilities.
