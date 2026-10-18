# Domain Docs

How engineering skills consume this repo's domain documentation.

## Layout

This repo uses a single-context layout:

- `GLOSSARY.md` at the repo root defines domain vocabulary.
- `docs/adr/` holds architectural decision records.

## Before exploring

Read `GLOSSARY.md` and any ADRs relevant to the area being explored.

If these files or directories do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. `/domain-modeling` creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

When naming a domain concept in an issue, proposal, hypothesis, or test, use the term defined in `GLOSSARY.md`. Avoid synonyms the glossary explicitly rejects.

If a needed concept is missing, reconsider whether the project uses that language. Note genuine gaps for `/domain-modeling`.

## Flag ADR conflicts

If a proposal or implementation contradicts an existing ADR, identify the ADR explicitly and explain why the decision should be reopened.
