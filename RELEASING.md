# Releasing

The extension is distributed through the public [Foxglove extension
registry](https://github.com/foxglove/extension-registry). The app fetches
`extensions.json` from that repo's `main` branch and then fetches the `.foxe`,
`readme`, and `changelog` URLs **directly from the end user's browser**, so every
URL in a registry entry must be publicly reachable without authentication.

## One-time prerequisites

- **The repo must be public.** While it is internal, the release asset and
  `raw.githubusercontent.com` URLs return 404, and the registry's `validate.ts`
  fails on the PR.
- **The license must permit redistribution.** `LICENSE` is MIT and
  `package.json` declares `"license": "MIT"`.

## Cutting a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` section for it.
   Never re-tag a version whose `.foxe` contents have changed; the registry pins
   an exact `sha256sum`.
2. Merge that to `main`.
3. Tag and push:

   ```sh
   git tag v0.2.6 && git push origin v0.2.6
   ```

   The `Release` workflow verifies the tag matches `package.json`, runs lint and
   typecheck, packages the `.foxe`, creates the release if needed, uploads the
   asset, and re-downloads it to confirm the hash matches what it built.

4. Un-mark the release as a pre-release. The registry should point at a normal
   published release.

## Submitting to the registry

The release job writes the entry to its **job summary** and uploads it as an
`entry.json` artifact. To regenerate it by hand:

```sh
pnpm run registry-entry --foxe https://github.com/foxglove/diy-dvr-panel/releases/download/v0.2.6/foxglove.diydvrextension-0.2.6.foxe
```

Then open a PR against [foxglove/extension-registry](https://github.com/foxglove/extension-registry):

- Append the entry to `extensions.json`. Entries are in submission order, not
  alphabetical, so it goes at the end of the array.
- Add one line to the README "Extensions" list, which **is** alphabetical.

The registry's CI validates only the changed entries: it fetches the `.foxe` and
checks the digest, opens the zip and requires a `package.json` with `name` and
`main`, requires `create-foxglove-extension` >= 1.0.3 in `devDependencies`, and
requires the `readme` and `changelog` URLs to return `text/plain` (a
`github.com` URL is rejected; use `raw.githubusercontent.com`).

## Reproducible packaging

`pnpm run package` runs `scripts/normalize-foxe.mjs` after
`foxglove-extension package`. `create-foxglove-extension` zips files with a fixed
modification date so `.foxe` files hash consistently, but it adds them with
jszip's `createFolders: true`, and jszip stamps the parent directories it
auto-creates with `new Date()`. That put the build wall-clock time on the `dist/`
entry and made every build hash differently. The normalize script rewrites the
DOS date/time fields of every entry, in both the local file headers and the
central directory, without touching any compressed stream.

Reproducibility holds for a given toolchain; a different Node or OS may produce
different webpack output. Always take the registry `sha256sum` from the release
job, never from a local rebuild.
