# Setting up Trello alerts

Trello is the only alert channel: when a connection needs re-authorising,
a card opens automatically and closes itself once the connection is
restored again. See [docs/operations.md](operations.md) for the lifecycle;
this page is just getting the credentials and list ids in place.

## 1. A board with two lists

Use an existing board or create a new one, with (at least) two lists:

- One list new reconnect cards open in — this is `TRELLO_MUST_LIST_ID`.
- One list resolved cards move to — this is `TRELLO_DONE_LIST_ID`.

They can be two lists on a board you already use, or a dedicated board just
for this. Nothing about the app cares which.

## 2. An API key and token

1. Get an API key at <https://trello.com/power-ups/admin> (create a
   Power-Up if prompted, or use the classic key page at
   <https://trello.com/app-key>) — this is `TRELLO_KEY`.
2. From the same page, generate a **token** authorising that key against
   your account with read/write access. This is `TRELLO_TOKEN`. Trello
   walks you through an authorisation page; approve it and copy the token
   it shows you, since it is not shown again.

## 3. The two list ids

**(verify against Trello's current UI — this has moved before.)** The
simplest reliable way to get a list's id is the REST API itself, using the
key and token from the previous step:

```sh
curl "https://api.trello.com/1/boards/<BOARD_ID>/lists?key=<TRELLO_KEY>&token=<TRELLO_TOKEN>"
```

The board id is in its URL (`https://trello.com/b/<BOARD_ID>/...`). The
response is a JSON array of lists; each object's `id` field is what goes
into `TRELLO_MUST_LIST_ID` or `TRELLO_DONE_LIST_ID`, matched by `name`.

## 4. Set the secrets

```sh
npx wrangler secret put TRELLO_KEY
npx wrangler secret put TRELLO_TOKEN
npx wrangler secret put TRELLO_MUST_LIST_ID
npx wrangler secret put TRELLO_DONE_LIST_ID
```

## 5. Test it

In the admin UI, open **Alerts** and click **Send test card**. This opens a
real, disposable card on the "must" list titled `Healthy test card
<timestamp>`, confirming the key, token and list id are all correct without
waiting for a real connection to fail. The UI shows an **Archive test
card** button once it is created — use it to clean up, or archive the card
from Trello directly.

If the test card fails to create, the most common causes are a stale token
(tokens can be revoked from your Trello account's settings) or a list id
copied from the wrong board.
