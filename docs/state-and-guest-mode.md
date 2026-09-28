# State, Auto-save, and Guest Mode

How the SPA holds its data, when it saves, and how anonymous users are supported.

For the resource math itself see
[resource-projection-logic.md](resource-projection-logic.md).

---

## State management

All data lives in a **single React Context** defined in
`services/CalculatorProvider.tsx`. The provider fetches everything on mount
(`initialCalculatorDataFetch`) and exposes it via `useCalculatorData()`.

The backend's `GET /calculator-data` returns one aggregated payload — all reference data,
the user's stats, planned banners, events, and banner timelines — specifically so the
frontend does not have to make N+1 fetches.

### Loading is the consumer's business, not the provider's

The provider **always renders its children**, and publishes `isLoading` / `fetchError` on the
context instead of gating the tree itself. It used to return a bare spinner until the fetch
landed, which blanked the navbar and footer along with everything else.

`views/ApplicationViews.tsx` owns the gate now: it paints the app shell immediately and shows
the spinner in the page area alone. The routed pages (`CaratCalculator`, `Timeline`,
`Selectors`) stay behind it — they all assume their collections are populated, and nothing has
changed about that guarantee.

**Anything that renders OUTSIDE the gate must tolerate empty collections**, because while
`isLoading` is true every array on the context is still at its initial `[]` and
`userStatsData` is `null`. `Navbar` is the one such component today: its "Sign in to save"
button is disabled while loading, since stashing an empty plan would clear a guest's
already-stashed one.

### The payload is prefetched

`prefetchCalculatorData()` (`services/calculatorFetchCalls.ts`) starts the request before the
calculator is opened — on the home page during an idle callback, and on hover/focus of any
link into `/app` from outside the provider. `initialCalculatorDataFetch()` then reuses that
in-flight request rather than starting a second one.

Two guards on the reuse, both load-bearing: the prefetch is discarded if **the auth token has
changed** since it went out (otherwise a guest response — an empty plan — could be served to
someone who signed in meanwhile), and if it is **older than five minutes**. Consumers always
get a `clone()`, because a `Response` body reads only once and the provider legitimately
consumes it twice (StrictMode in dev, and the stale-token retry after a 401).

---

## Auto-save

For logged-in users, changes to user stats or planned banners trigger a **debounced PATCH
(5 s delay)** via the `useAutoSave` hook.

The PATCH carries `plan_id`, the plan the banner rows were loaded from. See "Plans" below
for why it is never "whichever plan is active".

- Save state is surfaced through Sonner toasts.
- An `onbeforeunload` warning fires if a save is still pending.
- **Guests never arm the timer.** Their plan is not saved to the API. A tab-scoped snapshot
  is kept temporarily so opening a public shared plan can be reversed even if the provider
  remounts; it is restored only for a shared-plan visit. A fresh `/app` load clears that
  backup, so an ordinary refresh still starts with a new guest plan.
- **A row's note commits on blur, not per keystroke.** `BannerNoteEditor`
  (`components/carat-calculator/BannerNote.tsx`) keeps the text in local state while the
  person types, because every change to `userPlannedBannerData` re-arms this timer and the
  PATCH re-sends the whole row list. The note is an optional `note?: string` on the row and
  needs no mapping: `toBannerPayload` spreads the row, so autosave, the Navbar save and the
  guest migration all carry it. `NOTE_MAX_LENGTH` (500) mirrors the API's cap, and the
  textarea's `maxLength` keeps a save from ever failing on it.

---

## Plans

A signed-in account holds up to five named pull plans and the calculator shows one at a
time. **A plan is its banner rows and nothing else, plus at most a pointer to which of the
owner's stats blocks it reads.** Step-up selections belong to the account and stay put when
the plan changes. Stats, toggles and planned purchases belong to the account too, but a
plan with "separate resources" on (`income_profile_id` non-null) reads and saves its own
copy of all three, for people who plan for more than one game account. The purchases
follow the stats because they feed the same income (since 2026-09-24; before that they
were the account's under every plan). The reasoning, and why it keeps a plan safe to copy
between accounts later, is in
[../../backend/docs/data-model.md](../../backend/docs/data-model.md) ("`Plan`" and
"`IncomeProfile`").

That split is why the projection engine did not change. `useBannerResources` reads
`userPlannedBannerData`, `userStatsData` and `userPlannedPurchaseData` as it always did;
they now mean "the open plan's". The client never decides which block a plan reads:
`GET /plans/<id>` sends `user_stats_data` and `user_planned_purchase_data` beside the rows,
in the same shape either way, and `applyPlan` swaps all three in together. Either key may
be absent from an older API, and then what is on screen is kept. The save path is
unchanged because `PATCH /calculator-data` already carries the plan id beside the stats
and purchases. The Selectors page, which has no plan switcher, says whose purchases it
shows when the open plan has separate resources on.

The provider adds `plans`, `activePlanId`, `isPlanBusy` and five actions (`switchPlan`,
`createPlan`, `renamePlan`, `deletePlan`, `setSeparateIncome`).
`components/carat-calculator/PlanSwitcher.tsx` is the only UI for them and owns no logic of
its own.

### Save what is on screen before replacing it

The server deletes every banner row a save does not name, and the rows in React state are
the only copy of an unsaved edit. Every rule below follows from those two facts.

- **A save names its plan.** `userCalculatorDataPatch` takes `planId` first, and
  `performSave` passes the `activePlanId` from the same render as the rows. They are only
  ever set together (`applyPlan`), so a save cannot pair one plan's id with another's rows.

  | Time | What happens |
  |---|---|
  | 12:00:00 | edit a row in plan A, the 5 s timer starts |
  | 12:00:03 | switch to plan B |
  | 12:00:05 | without the rule: A's rows are written over B |

- **Every action flushes first.** `flushPendingSave()` runs `saveNow()` when a save is
  pending and reports whether it landed (`lastSaveOkRef`). On a failure the action stops
  and the user stays where they were, unsaved edit still on screen.
- **Rows and stats from the server are not an edit.** `applyPlan` sets the plan id, the
  rows and (when the response carries them) the stats in one tick, with
  `suppressAutoSaveRef` set so the auto-save effect skips the change it is about to cause.
  An API from before separate resources sends no stats and the ones on screen are kept. `activePlanId` is in that
  effect's deps so the effect is guaranteed to run and clear the flag; otherwise a flag
  left set would swallow the user's next real edit.
- **Staged rows are cleared on a switch.** They were being composed for the plan just left.
- **Deleting the open plan drops its pending save** (`cancelTimer` on `useAutoSave`)
  instead of firing it at an id that no longer exists. Deleting a *different* plan flushes
  as usual, because that edit is still wanted.
- **Separate resources flushes first, for the STATS.** Turning it on makes the server copy
  the stats the plan reads today, from the database. A stats edit still sitting in the
  five-second window would be missing from that copy, so `setSeparateIncome` runs
  `flushPendingSave()` before the PATCH, then refetches the plan through `planFetch` and
  `applyPlan`, the same path a switch uses. Turning it off discards the plan's own copy, so
  the switcher confirms that direction the way it confirms Delete.
- **Create makes the plan, then opens it.** The server creates plans inactive; `createPlan`
  activates it only after the flush, and a copy is taken after the flush so it includes the
  edit made two seconds ago.

`__tests__/calculatorProviderPlans.test.tsx` pins the ordering. None of these failures
throw. They lose banners.

### Guests, and an API without plans

For a guest `plans` is `[]` and `activePlanId` is `null`, and `PlanSwitcher` renders
nothing. An API from before plans existed sends neither key and gets the same treatment:
the switcher is hidden and saves omit `plan_id`, which the server reads as the account's
only plan. Guest migration is unchanged and sends `data.active_plan_id`, so a guest's rows
join the active plan.

`PlanSwitcher` is a header bar in the Income & Resources style with **one tab per plan**, a
"New" button and a "..." menu for the open plan. Below `@min-[40rem]` (a container query on
the planner box, like `@banner-table:`) the tabs give way to a single dropdown, because five
names do not fit a phone. Both layouts are always in the DOM and CSS shows one, so nothing
in JS knows which is visible: each opener records what the popover should show and which
control it hangs from.

The popover is portalled to `<body>` like `CountStepper`'s pad. The planner box is
`overflow-hidden` and an `@container`, which clips even a fixed-position child, and a new
plan has no rows to make the box taller than the menu.

---

## Guest mode

The app is fully usable without an account. No route requires one; signing in is only
needed to *save* a plan.

- The API returns `user_stats_data: null` for anonymous requests, and the frontend seeds
  `DEFAULT_GUEST_STATS` from that.
- Guests plan in memory. A refresh discards the plan, by design.
- A request carrying an **invalid** token still 401s even on public endpoints (DRF
  authenticates before permissions run). The frontend clears the token and retries as a
  guest.

### Guest → account migration (`services/guestMigration.ts`)

The Navbar shows a "Sign in to save" button that **snapshots the guest plan into
sessionStorage** (`guestPlanMigration.v1`, 1-hour expiry) before navigating to `/login`.

The snapshot is necessary because `CalculatorProvider` unmounts on route change — without
it the plan would simply be gone by the time the user came back.

On the next provider mount **with** a token, the stash is migrated via PATCH **before any
state is set**, so auto-save cannot race it:

- account banners are preserved (sent **with** ids),
- guest banners are appended (sent **without** ids),
- planned **purchases** follow exactly the same rule, in their own `purchases` key,
- guest stats are sent only if edited away from the defaults (`statsAreDirty`).

`purchases` is optional on `GuestPlanStash` so a stash written before the Selectors page
existed still validates — the version stays `1` because an absent key degrades to "no
purchases", which is correct rather than a reason to discard the whole plan.

The guest stash survives the OAuth round trip unchanged — sessionStorage persists across a
same-tab navigation to the provider and back — so social sign-in reuses this machinery
with no changes of its own.

---

## Social sign-in, client side

`services/socialAuth.ts`:

- `startSocialLogin(provider)` fetches the consent URL, parks
  `{provider, state, createdAt}` in sessionStorage under `oauthState.v1`, then
  `window.location.assign`s to the provider.
- `completeSocialLogin` reads and **immediately clears** that entry (single-use by
  design), compares the returned `state`, then POSTs the code.

`components/auth/OAuthCallback.tsx` drives this and **guards the exchange with a
`useRef`**. The authorization code is single-use, so StrictMode's double mount would
otherwise replay a spent code and show an error to a user who actually signed in fine.

Server-side flow, scopes, and the privacy constraints:
[../../backend/docs/auth-and-privacy.md](../../backend/docs/auth-and-privacy.md).

## Account linking, client side

`services/accountLinking.ts` attaches another provider to the account that is
**already signed in** — the same OAuth round trip against `/account/link/*`
instead of `/auth/*`, authenticated, and it never signs anyone in or creates an
account.

- `startAccountLink(provider)` parks `{provider, state, createdAt}` under
  **`accountLinkState.v1`** — deliberately a different key from sign-in's
  `oauthState.v1`, mirroring the two salts on the server. One key with a mode
  flag would be one bad branch away from finishing the wrong flow.
- `completeAccountLink` consumes that entry (single-use) and resolves to the new
  `LinkedProvider` row; a 409 passes the **server's** message through, because
  it says which conflict it was ("already linked to a different account" vs
  "this account already has a google login").
- `unlinkProvider` DELETEs. The server refuses to remove the **last** sign-in
  method of a password-less account (400, with a message); the account page
  disables the button as a courtesy, but the rule lives on the server.

`components/auth/OAuthCallback.tsx` is **shared by both flows**. At mount it asks
`peekPendingLinkProvider()` (non-consuming) — but only while `isLoggedIn`,
because a link can only have been started by someone signed in, and a parked
link in a token-less tab is stale. A link then finishes with `refresh()` and
lands on `/account`; otherwise it is the sign-in flow exactly as before. The
flow is latched in a `useState` initialiser so the error screen cannot flip to
sign-in copy after the pending entry has been consumed — this is the one
render-time storage read outside the `/app` gate, allowed because this route is
never prerendered or hydrated.

`components/account/AccountPage.tsx` (`/account`, noindex, **not** prerendered —
like `/login`) is where linking is reachable from: connected providers with
connect/disconnect, supporter status and named benefits, sign-out. A guest sees
a sign-in card, never a redirect; no route requires an account.

---

## Type system

Planned banners use a **discriminated union**:

- `SavedPlannedBanner` — has `id` (from the DB) and `user`
- `LocalPlannedBanner` — has `tempId` (client-only, before first save)

Narrow with the `isSavedBanner()` / `isLocalBanner()` type guards.

Request types use IDs (e.g. `banner_uma: number | null`); response types use nested
objects. All types live in `src/types/` and are barrel-exported from `src/types/index.ts`.

---

## Auth token and the account

Two layers, and the split matters.

### `services/authToken.ts` — owns the stored token

The **only** module that touches the `authToken` key. `getAuthToken()`,
`setAuthToken()`, `clearAuthToken()`, and `authHeaders()` (an empty object for a
guest — sending `Token null` would make the backend reject an otherwise valid
guest request).

Writes **notify subscribers**, and that is the reason the module exists rather
than being a convenience wrapper. Before it, the calculator could drop a stale
token after a 401 and nothing else found out, so the navbar carried on offering
"Logout" to someone the server no longer recognised. A `storage` listener covers
the same change made in another tab.

**Always clear through `clearAuthToken()`**, never `localStorage.removeItem`, or
`AuthProvider` keeps serving a signed-in answer.

### `services/AuthProvider.tsx` + `AuthContext.ts` — owns the account

Wraps every route in `App.tsx` (not just `/app`) because the navbar needs it on
the home page, and the Phase 3 ad loader will need it everywhere. `useAccount()`
gives:

| Value | Meaning |
|---|---|
| `isLoggedIn` | Is a token present. **Synchronous** on a normal client render. On a prerendered page it is `false` in the static HTML and during hydration (the build ran as a guest) and corrects itself in the first commit after — see the `AuthProvider` docblock. |
| `status` | `anonymous` / `loading` / `ready` / `error` — how far `GET /account` got. |
| `account` | The summary, or `null` until it loads. Includes `avatar_url` — a supporter's first oshi while their tier covers a slot, else `null` (free accounts always get null: the picture is the perk) — `oshis` (every pick they hold) and `oshi_slots` (how many the tier covers, 0 for free), and `display_name`, the name they chose or `""`. `components/account/Avatar.tsx` draws the picture and falls back to a quiet grey silhouette on `null` or a broken image. Both preferences are written by `accountPatch()` (`PATCH /account`) from the account page, which then calls `refresh()`. |
| `isSupporter` | `account.supporter.is_supporter`, false until positively known. For gating UI use `useHasBenefit(key)` / `<SupporterOnly benefit=…>` — they key on a **benefit**, not on this flag or the tier name. |
| `refresh()` | Re-read `/account` after something that could change entitlement. |
| `signOut()` | Deletes the server-side token, then clears it locally. |

**`isLoggedIn` and `account` answer different questions on different schedules,
deliberately.** Making `isLoggedIn` wait for `/account` would flash "Login" at
every returning user on every page load; trusting the token to imply a valid
account would show a signed-in shell to someone whose token was revoked. Keeping
both is what avoids each.

**`status` is not decoration.** "We don't know yet" and "not a supporter" must
never collapse into one value: anything that has to *fail open* on uncertainty —
the ad loader — can only express that by checking `status` as well as
`isSupporter`.

**A guest makes no request.** No token means `status` goes straight to
`anonymous`. Most traffic is anonymous and must not pay for a supporter feature.

Inside async callbacks, prefer `getAuthToken()` over the context value —
`CalculatorProvider` does — because a closure wants the live answer rather than
whatever was captured when it was created.

**Guest mode is unaffected.** No route requires an account; the provider only
describes one when it exists. See "Guest mode" above.

`supporter` is real as of Phase 2: the server derives it per request from the
linked Patreon supporter row. When there is no entitlement the block is
`{ is_supporter: false }` and **nothing else** — `tier` and `benefits` are
absent rather than null, so neither can be misread as a checked-and-empty
answer.

**Gate on a benefit key, never on the tier name.** `benefits` is a list of
capability keys (`"ad_free"`, …) and the server decides which tiers earn which;
matching on `tier` would put a copy of the paywall in the bundle, free to
disagree with the real one, and would break the day a tier is renamed on
Patreon. `AuthProvider` already exposes `isSupporter` derived from
`account?.supporter.is_supporter ?? false`, which is the fail-closed default —
paired with `status`, that is what lets Phase 3's ad loader fail *open*.
