## What this changes

<!-- And why. The interesting part is usually the constraint you discovered. -->

## How it was tested

<!--
Say what you actually ran, and what you could not. "No Chrome on this machine,
so test:responsive is unverified" is a genuinely useful line in a review.
-->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:frontend`
- [ ] `npm run test:all` (for pipeline, uploader or API changes)

## Checklist

- [ ] New behaviour has a test; a bug fix has a test that fails without the fix
- [ ] Any new setting is in the Zod schema **and** documented in `.env.example`
- [ ] `process.env` is still read only in `src/config/index.ts` (see the one documented exception in `jellyfin-bootstrap.ts`)
- [ ] No secret can reach a log, an API response, or a command line
- [ ] Migrations are new files, not edits to ones that have shipped
- [ ] Docs updated if behaviour or configuration changed

## Notes for the upgrader

<!--
If you changed a default or a required setting, what happens to somebody who
pulls this without reading the changelog? Write "none" if nothing.
-->
