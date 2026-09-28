# box-folder-owner-migration

Transfers ownership of existing Box folders from a shared admin or service
account to the real person each one belongs to, using the Box API.

Companion write-up with the full background (why this exists, what it looks
like end to end): [How to Migrate Box Folder Ownership from a Service
Account to Users Programmatically](https://bachelor-tech.com/how-to-migrate-box-folder-ownership-from-a-service-account-to-users-programmatically).
This repo is the code; that post is the story. If you found this repo first,
read the post too. It covers a couple of gotchas that aren't obvious from
the code alone.

If you're here for provisioning brand-new home folders for new users
instead of migrating existing ones, that's a related but different problem.
See my other post, [How to programmatically create home folders for new
users on Box with Azure Functions](https://bachelor-tech.com/how-to-programmatically-create-home-folders-for-new-users-on-box-with-azure).

## The problem this solves

A common pattern in Box (and honestly in most cloud storage): someone sets
up shared "home folders" for employees under one admin or service account,
because that was the easiest way to bootstrap it. Years later, that admin
account has standing access to every one of those folders, and untangling
it looks scary. You can't just "change the owner" from the UI on hundreds
of folders one at a time, and getting it wrong on a large folder is not
something you want to find out about after the fact.

This tool does exactly one thing: given a folder ID and the Box user ID of
the person it should belong to, it transfers ownership to them and removes
every other standing collaborator (except anyone you explicitly say to
keep). It's a metadata operation in Box, not a data operation. A 150 GB
folder transfers just as fast as an empty one, because nothing is actually
copied.

It always dry-runs first. Nothing changes until you explicitly confirm.

## How it works, in short

1. Read the folder's current owner and collaborator list.
2. If any of that access comes from a *parent* folder rather than the
   folder itself (common if these folders sit inside a shared structure),
   move the folder out to sever that inherited access. Ownership transfer
   alone does not remove it, which is easy to miss.
3. Add the target user as a collaborator if they aren't already one.
4. Upgrade their collaboration to owner. Box transfers ownership and
   automatically demotes the previous owner to editor as a side effect.
5. Remove every other collaborator except anyone you named to keep.
6. Rename the folder to `<Name> - Home` (cosmetic, non-fatal if it fails).

Every step before `confirm: true` is a read-only report, and the report
tells you exactly what would be removed, kept, or moved before you commit
to anything.

## 1. Prerequisites

- **Node.js 22** and npm.
- **Azure Functions Core Tools v4**: `npm install -g azure-functions-core-tools@4`.
  This runs the tool locally as a real Azure Functions host (the same
  runtime a deployed Function App uses), just on your own machine. Nothing
  here needs an actual Azure subscription; it never leaves localhost.
- This project's dependencies:
  ```bash
  npm install
  ```
- A `local.settings.json`, copied from `local.settings.json.example` as-is.
  No values need to be filled in. This is only needed so the local
  Functions host has somewhere to start.

## 2. One-time Box setup

The tool needs to act as the folder's *current owner*, because only a
folder's current owner can hand it to someone else. Not a co-owner, not an
admin with broader permissions, only the literal current owner. Confirmed
directly against Box's API: attempting this as anything less returns a 403.

### 2a. Create an OAuth app

1. Sign in to [account.box.com/developers/console](https://account.box.com/developers/console)
   **as the account that currently owns the folders** you're migrating.
2. **Create New App** → **Custom App** → **User Authentication (OAuth 2.0)**.
3. On the app's **Configuration** tab:
   - Under **OAuth 2.0 Redirect URIs**, add exactly:
     `http://localhost:8765/callback`
   - Leave **Make API calls using the as-user header** and
     **Generate user access tokens** both **off**. Neither is needed here,
     and turning either on gives the app standing impersonation power over
     every user in your enterprise, which is the opposite of what this
     tool is for.
   - Under **Content Actions**, check "Read all files and folders" and
     "Write all files and folders".
   - Under **Administrative Actions**, check **Manage Users**, needed for
     the storage-limit check and for looking up Box user IDs by email. Save.
4. Have an enterprise admin authorize the app (Admin Console → Platform
   Apps), which the Manage Users scope requires.
5. Copy the **Client ID** and **Client Secret** from the Configuration tab
   somewhere private. You'll need them once, in the next step.

### 2b. Sign in once

```bash
node tools/boxLogin.js
```

It asks for the Client ID and Client Secret the first time only, then
prints a URL. Open it in a **private/incognito browser window** (not your
normal profile, since it needs to be the folder owner's session, not
yours), and sign in there, approving the app.

The login is stored in `~/.box-migration` on your machine, never in this
project folder. It refreshes itself automatically; a session stays usable
for up to 60 days after its last use. Run `node tools/boxLogin.js --logout`
when you're done, and delete the app in the Developer Console.

## 3. Running it

### 3a. Start the local server

```bash
func start
```

Leave this running. Everything below talks to `http://localhost:7071`.
Client and server both run on your own machine.

### 3b. Find the folder ID and the target user's Box ID

Folder ID is in the folder's URL in the Box web UI:
`https://<enterprise>.app.box.com/folder/123456789` → `123456789`.

To list everything inside one or more parent folders at once, as a CSV:

```bash
node tools/listFolderContents.js "HR:111111111" "Sales:222222222"
```

To look up someone's Box user ID by email:

```bash
node tools/lookupUsers.js someone@example.com
```

If it reports "NOT FOUND (exact login), but the search returned:" followed
by a list, the email you tried isn't that person's actual Box login. Some
accounts (especially older ones) can have a different login than their
real email. Check the returned list for their name.

### 3c. Dry run: always do this first

```bash
curl -X POST http://localhost:7071/api/migrateHomeFolder \
  -H "Content-Type: application/json" \
  -d '{"folderId": "123456789", "userId": "987654321", "userName": "Jane Doe"}'
```

With no `confirm`, this changes nothing. It reports:

| Field | Meaning |
|---|---|
| `currentOwner` | Who owns the folder right now. Should be the account you signed in as. |
| `storageCheck` | Whether the target user's storage limit can hold this folder. A confirmed run refuses to proceed if it can't. |
| `wouldRemove` | Direct collaborators that would lose access. Removal is the default. |
| `wouldKeep` / `wouldAddDirect` | Anyone explicitly kept via `keepCollaboratorIds`. |
| `inheritedCollaborators` | People who have access only because they collaborate on a *parent* folder, not this one directly. Never touched directly; see `wouldMoveOutOfTree` below. |
| `wouldMoveOutOfTree` | Whether the folder needs to be relocated first to actually sever inherited access. |

### 3d. The real run

Same request, with `confirm` added:

```bash
curl -X POST http://localhost:7071/api/migrateHomeFolder \
  -H "Content-Type: application/json" \
  -d '{"folderId": "123456789", "userId": "987654321", "userName": "Jane Doe", "confirm": true}'
```

To keep specific people's access (e.g. a manager who has a legitimate
reason to see this folder), add their Box user IDs:

```bash
curl -X POST http://localhost:7071/api/migrateHomeFolder \
  -H "Content-Type: application/json" \
  -d '{"folderId": "123456789", "userId": "987654321", "userName": "Jane Doe", "confirm": true, "keepCollaboratorIds": ["111", "222"]}'
```

### 3e. Verify

Run the exact same dry-run request from 3c again. A `404 "not_found"`
response means the old owner can no longer see the folder at all. That's
success, not an error, because that account genuinely has no more access
to check.

## 4. What can go wrong (and isn't a bug)

- **`403 storage_limit_exceeded`** (shows up in `storageCheck` as
  `sufficient: false` before you even try `confirm`): the target user's own
  Box storage limit is too small for this folder. Raise it in the Admin
  Console and try again.
- **`409 operation_blocked_temporary`** on the confirm step: Box is still
  finishing background work on this folder, or on a sibling folder migrated
  moments earlier from the same parent structure. **This does not mean
  nothing happened.** An earlier step in the same request (commonly, the
  move out of the parent tree) can have already succeeded even though the
  overall request errored. The error message tells you the folder's actual
  current state, so read it before retrying. Retrying the same request
  (still with `confirm`) picks up from wherever it actually left off; it
  doesn't redo or duplicate completed steps. Sometimes an immediate retry
  clears it; for very large folders it can take longer, occasionally over
  an hour. Don't retry in a tight loop.
- **Inherited vs. direct access looks identical at first glance, but isn't.**
  A folder's collaborator list, as Box's API returns it, includes access
  inherited from parent folders mixed in with access set directly on the
  folder. An inherited entry's `item` field names the *ancestor* it was
  created on, not the folder you asked about. Upgrading or deleting one by
  mistake changes the whole parent tree: every other folder under it, not
  just the one you meant. This script only ever touches collaborations
  whose `item` is the exact folder being migrated, and double-checks that
  by ID immediately before every change, straight from Box, rather than
  trusting the list it already has in memory.
- **A folder that keeps its non-"Lastname, Firstname" name**, or doesn't
  visibly move in the Box UI: neither matters. Ownership is what counts;
  name and tree position are cosmetic.

## License

MIT. See [LICENSE](LICENSE).
