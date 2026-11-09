<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `videos` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# Videos

Browses NIP-71 video events (kinds 34235 and 34236): filter by length and topic, open the
author's profile, and play through the shell's player.

Package: `@hyprgate/napp-videos`. Source lives in the Hyprgate monorepo at `napplets/videos`.
The standalone `hyprgate/napplet-videos` repository is a generated, read-only mirror, so send
changes to `hyprgate/web`.

## Working on it

Run these from the Hyprgate checkout so `workspace:*` packages resolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter ./napplets/videos paja        # Kehto Paja plus the Vite dev server
pnpm --filter ./napplets/videos exec vitest run
pnpm --filter ./napplets/videos type-check
pnpm --filter ./napplets/videos conformance # builds, then checks dist/
```

## Manifest domains

Requires `relay`, `outbox`, `media`, `resource` and `intent` (for opening an author's profile).
`theme` is optional.
