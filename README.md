# IPO Pulse Workbench

Time-first IPO intelligence for market professionals.

This deployable worker provides a live feed of recent official SEC EDGAR IPO lifecycle filings:

- S-1 — initial US registration
- F-1 — foreign issuer registration
- EFFECT — registration effective
- 424B4 — final prospectus

The front end refreshes every minute and links each item to its original SEC filing. The source is public and no credentials are stored in this repository.

## Deployment

This repository contains the Sites deployment artifact:

- `dist/server/index.js` — standalone Worker entrypoint
- `.openai/hosting.json` — Sites project configuration

Deploy the artifact through OpenAI Sites to publish the live workbench.
