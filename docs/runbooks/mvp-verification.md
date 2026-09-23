# MVP verification report (Task 17b)

Run on **2026-09-23 (UTC)** against production. The run used the Playwright MCP browser, with curl for the API checks.

- Platform: https://bioregionalpassport.org
- Pods: https://boulder.bioregionalpassport.org and https://tenant-zero.bioregionalpassport.org

Every step that creates a member ran on **tenant-zero**, the synthetic demo pod. Boulder was only read.

Screenshots are kept outside the repo, in the session scratchpad (`…/scratchpad/e2e/`):

| File | What it shows |
|---|---|
| `02-boulder-home.png` | Boulder pod home, themed |
| `03-wallet-visitor.png` | Wallet after joining: Visitor badge and the "Find an attestation event" CTA |
| `04-wallet-steward.png` | Wallet after the steward bootstrap: Steward badge |
| `06-demo-member-t1.png` | `/wallet/demo`: the second phone becomes a Member |
| `07-grants-tally.png` | Published tally for the grants round |
| `08-pay-receipt.png` | Wallet Pay receipt |

## Story

A resident lands on the platform and opens a pod: a themed home, the map, the directory, the events and the governance page. They create a passport in the wallet, back it up and join tenant-zero as a Visitor. The operator bootstraps them as the first steward, and they accept that grant in the wallet and become T3. As steward they:

1. convene an attestation event;
2. witness a simulated neighbour pair, which takes the second phone from Visitor to Member (T1);
3. run a quadratic grants round from start to published tally;
4. open a credit account and pay a merchant in credits.

The run also checked two server-side guarantees: a session from one pod is refused by another pod, and the platform registry recognises both pods.

## Flow Status

| # | Step | Status | Evidence |
|---|---|---|---|
| 1 | Landing page, pod links, `/api/health` | ✅ | See 1 below |
| 2a | Boulder home themed, nav | ✅ | See 2a below |
| 2b | Map shows seeded enterprises | ❌ (UI) / ✅ (API) | See 2b below |
| 2c | Directory lists enterprises | ❌ (UI) / ✅ (API) | See 2c below |
| 2d | Events lists the seeded attestation event | ❌ | See 2d below |
| 2e | Governance: disclosure sentence and tiers | ✅ | See 2e below |
| 2f | `/.well-known/bioregion.json` is signed | ✅ | See 2f below |
| 3 | Wallet onboarding, join tenant-zero, Visitor, CTA | ✅ | See 3 below |
| 4 | Steward bootstrap, then consent, then T3 | ✅ | See 4 below |
| 5 | Steward creates an attestation event | ✅ | See 5 below |
| 6 | `/wallet/demo`: second phone becomes Member (T1) | ✅ | See 6 below |
| 7 | Grants: create, open, propose, vote, close, publish, verify; refusal sentence | ✅ (with issues 4 and 5) | See 7 below |
| 8a | Credits: Open my account, balance and limit | ✅ | See 8a below |
| 8b | Merchant Mode UI on tenant-zero | ❌ | See 8b below |
| 8c | Payment request, then wallet Pay, then receipt | ✅ (via the API, not the Merchant UI) | See 8c below |
| 9 | Cross-pod refusal | ✅ | See 9 below |
| 10 | Registry recognition and authorization | ✅ | See 10 below |

### Evidence

**1. Landing page, pod links, `/api/health`**
- The landing page lists "Boulder Commons" and "Tenant Zero". Each has Visit, "Open here" and Manifest links.
- Every link returns 200: both pod hosts, `/p/boulder`, `/p/tenant-zero`, both manifests, `/operator` and the platform card.
- `/api/health` returns `{"ok":true,"pods":2,"pendingPlatformMigrations":[],"platformMigrations":2}`.
- No console errors.

**2a. Boulder home themed, nav**
- The theme wrapper `DIV.bp-theme` has inline `--bp-primary: #1F5F4A`, and the computed value is the same.
- Nav: Home, Map, Directory, Events, Grants, Credits (`/circulation`), Merchant Mode, Passport (`/wallet?pod=boulder`), Governance.
- H1: "Welcome, neighbor." No console errors.
- Screenshot: `02-boulder-home.png`.

**2b. Map**
- `/map` renders a placeholder: "Opening soon — Boulder Commons is setting this up…". It draws no canvas and no markers.
- The API is fine: `GET /api/appview/map` returns a FeatureCollection with 11 features: 8 enterprises (Kinnikinnick Farm Stand, Sourdough & Rye Bakery, …) and 3 events.

**2c. Directory**
- `/directory` shows the same "Opening soon" placeholder.
- `GET /api/appview/directory` returns 8 entries.

**2d. Events**
- `/events` says "No gatherings are scheduled yet".
- The seeded appview event "Boulder Creek Cleanup + Attestation" (`attestation: true`) exists at `GET /api/appview/records/event`.
- `GET /api/vta/events` returns `{"events":[]}`.

**2e. Governance**
- The page shows "What we disclose — Member identifiers are never disclosed beyond the pod VTA."
- It lists the tiers Member, Trusted neighbor, Steward and Anchor, each with its plain-sentence criteria.
- It also says "Permissions last 90 days…" and "No government ID is ever required."

**2f. Signed manifest**
- The Boulder manifest has `proof`:
  - `DataIntegrityProof`, `eddsa-jcs-2022`;
  - `assertionMethod`, `verificationMethod did:web:bioregionalpassport.org:dids:boulder#…`.

**3. Wallet onboarding**
- The onboarding sequence at `https://bioregionalpassport.org/wallet?pod=tenant-zero`:
  1. Create;
  2. Keep it safe. A passphrase backup was downloaded (`passport-backup-2026-09-23.json`) and the page said "Backup downloaded…";
  3. Continue;
  4. "Join Tenant Zero".
- Pod home: "Your passport in Tenant Zero", badge **Visitor**, with the "Find an attestation event" link to `/wallet/events?pod=tenant-zero`.
- "Why this tier" says: "You have joined Tenant Zero, but membership is only given in person, at an attestation event."
- Screenshot: `03-wallet-visitor.png`.

**4. Steward bootstrap**
- The "Copy" button put the full DID on the clipboard: `did:key:z6MksViFsZwDsZk82Y9YPPfoNXEpFzafoT1T6uLqQuQEpmQY`.
- `POST /api/control/pods/tenant-zero/bootstrap-steward` with a Bearer operator token returned 200:
  - `member.tier: "T3"`;
  - a grant of type `MembershipCredential`, issued by `did:web:…:tenant-zero` and valid until 2026-12-22;
  - one VAC with 17 actions, including `event:convene` and `vwc:issue`.
- Pasting the grant into Settings, then "Add a credential", opened the consent screen: "Tenant Zero invites you to be a member".
- "I accept" called `POST /api/vta/membership/ack` (200), `GET /challenge` (200) and `POST /session` (200). The screen then said "You are now a Steward of Tenant Zero… You keep tier T3."
- After a refresh:
  - the badge reads **Steward**;
  - IndexedDB shows `tenant-zero:T3`, with credentials `membership-grant`, `membership-ack` and `authority`;
  - `event:convene` and `vwc:issue` are both present.
- Screenshot: `04-wallet-steward.png`.

**5. Attestation event**
- On the `https://tenant-zero.bioregionalpassport.org/steward` Events tab, "Create attestation event" sent `POST /api/vta/events` (201).
- The list shows "E2E verification gathering — ATTESTATION".
- The wallet session cookie reached the pod subdomain, so the steward console was authorised.

**6. `/wallet/demo`: second phone becomes Member (T1)**
- Sequence:
  1. "Simulate a second phone": the second phone joins as a visitor.
  2. The second phone meets a simulated neighbour, and they exchange both halves over the relay.
  3. As Demo convener, I picked "E2E verification gathering" and pressed "Witness", which sent `POST /api/vta/events/evt_9ejVud1QIdXZOskF/witness` (201).
  4. The second phone applied, then pressed "I accept".
- Final state: "The second phone went from Visitor to Member.", badge **Member**.
- "Why this tier":
  > Your membership pair is complete. / Admission at an attestation event places you at tier T1. / Issued tier T1 authorities (6 actions) valid until 2026-12-22.
- Plus 6 "You can…" sentences.
- No console errors. Screenshot: `06-demo-member-t1.png`.

**7. Grants**
- Round steward console:
  - "Create round" (pool 500, propose and vote T2+) said "Round created as a draft".
  - "Open for proposals and voting" sent `POST /api/round/rounds/rnd_lapirKAgBYYCnbVE/open` (200).
- The steward (T3) proposed "E2E seed library" (120 credit) with `POST …/proposals` (201).
- Voting worked only on the platform origin (issue 4). There, 2 votes cost 4 of 100 credits, and "Cast my ballot" sent `POST …/ballots` (201): "Ballot recorded…".
- "Close voting and count" sent `POST …/close` (200). "Publish results" was then pressed.
- Tally page shape:
  - a Results table with columns Proposal / Votes / Voters / Matching / Status (`E2E seed library | 2 | 1 | 500 credit | Funded`);
  - "Ballots counted 1";
  - a "Fingerprint of all ballots" (a sha256 hex string);
  - "Verify this tally", which returned "Verified: all 1 ballots are signed correctly and recomputing the tally gives the same result (500 matched).";
  - Published ballots: `did:key:z6Mkma…4jts · T3`.
- Refusal: a second round had proposals limited to T4+. Proposing as T3 returned 403, with the sentence **"Proposing in this round needs tier T4 or above."**
- Screenshot: `07-grants-tally.png`.

**8a. Credits: Open my account**
- `/p/tenant-zero/circulation` (platform host): "You do not have a credit account here yet…". The statement call returned 404 before the account existed, which is expected.
- "Open my account" sent `POST /api/gateway/accounts/open` (201).
- The page then showed:
  - Balance 0 credits;
  - Limit 1,000 credits (band L3);
  - Available 1,000.
- "Where credits are accepted" lists Tenant Zero General Store (up to 20%) and Tenant Zero Repair Bench (up to 75%).

**8b. Merchant Mode UI on tenant-zero**
- `/p/tenant-zero/merchant` returns **HTTP 404** ("We could not find that page.").
- Cause: the tenant-zero manifest has `modules.merchant: false`, and `merchant/page.tsx:13` 404s when that flag is off.

**8c. Payment request, wallet Pay, receipt (via the API)**
- Steps:
  1. `POST /api/gateway/merchant/enterprises` from the page, with the wallet's root pod VACs, returned 201: enterprise `did:key:z6MkubTc…fMo9`, "E2E Verification Stall", retail, maxShare 0.2, plus a `pay:receive` VAC.
  2. I added the VAC through Settings → "Add a credential", then re-presented the session (issue 6).
  3. `POST /api/gateway/pay/request` `{ totalSale: 20 USD, creditValue: 4 }` returned 201.
  4. In the wallet Pay screen I pasted the request; the confirm screen said "You pay 4 credit of a 20 USD sale; the remaining 16 USD goes on the merchant's usual payment."
  5. "Sign and pay" sent `POST /api/gateway/pay/authorize` (200).
- Payment request JSON, as the QR carries it (proof value truncated):

```json
{"type":"org.bioregion.pay.request","merchant":"did:key:z6MkubTc7fyN1iBygpvPKFuwFG31gDgqsXiSW7g4e8CtfMo9","pod":"did:web:bioregionalpassport.org:dids:tenant-zero","node":"https://tenant-zero.bioregionalpassport.org/api/gateway","amount":{"unit":"credit","value":4},"totalSale":{"unit":"USD","value":20},"invoice":"inv_3mw63dx73wsnk","expires":"2026-09-23T06:19:35.397Z","acceptance":{"maxShare":0.2,"requires":["MembershipCredential:pod","AuthorityCredential:credit:account"]},"proof":{"type":"DataIntegrityProof","cryptosuite":"eddsa-jcs-2022","verificationMethod":"did:web:bioregionalpassport.org:dids:tenant-zero#key-1","proofPurpose":"assertionMethod","proofValue":"z3rqqM2s…"}}
```

- **Result: a settled receipt.** "Paid — 4 credit — To E2E Verification Stall — Invoice inv_3mw63dx73wsnk — Receipt 2 — Your balance -4 credit — Pay the rest of the 20 USD sale the usual way."
- Screenshot: `08-pay-receipt.png`.

**9. Cross-pod refusal**
- With the tenant-zero session active, `https://boulder.bioregionalpassport.org/circulation` shows "Present your passport".
- `GET https://boulder.bioregionalpassport.org/api/gateway/accounts/me` returns **403** `{"code":"POD_MISMATCH","message":"Your passport session was issued by a different pod.","hint":"Present your passport to this pod first."}`. `…/accounts/me/statement` returns the same.
- Without a cookie (curl), the same call returns 401 `UNAUTHENTICATED` ("You need to present your passport before doing this.").

**10. Registry**
- `GET /api/registry/recognition` lists `boulder` and `tenant-zero`. Each has its `did:web:bioregionalpassport.org:dids:<slug>`, `acceptedIssuers` and `manifestUrl`.
- `GET /api/registry/authorization?entity=did:web:bioregionalpassport.org:dids:boulder&authority=issue:MembershipCredential` returns `{"authorized":true,"reason":"did:web:bioregionalpassport.org:dids:boulder is the registered pod boulder and may issue:MembershipCredential."}`.

## Issues Found

1. **Map page is a placeholder.**
   - Error text: "Opening soon — Boulder Commons is setting this up. In the meantime, the best way in is an in-person gathering."
   - `/api/appview/map` already returns 11 features, but no page uses it.
   - Suspected file: `apps/web/app/p/[slug]/[section]/page.tsx`. `SECTIONS = new Set(['map', 'directory', 'grants'])` renders `EmptyState`, and there is no `app/p/[slug]/map/` route.

2. **Directory page is a placeholder.**
   - Same "Opening soon" text, while `/api/appview/directory` returns 8 entries.
   - Suspected files: `apps/web/app/p/[slug]/[section]/page.tsx`, and a missing `app/p/[slug]/directory/` route.

3. **The seeded attestation event is not on the Events page.**
   - Error text: "No gatherings are scheduled yet".
   - The page reads the pod-vta `events` table (`select … from events` in `apps/web/app/p/[slug]/events/page.tsx:23-37`). The seeds (`seedDemoRecords`, `services/appview`) write `org.bioregion.event` appview records, so "Boulder Creek Cleanup + Attestation" exists only in the appview.
   - Either the seed should also create a pod-vta event, or the page should merge in appview events.

4. **Voting is unavailable on the pod host.**
   - On `https://tenant-zero.bioregionalpassport.org/grants/<id>` the Vote section shows only "Open your passport to vote. Your ballot is signed on this device…". This is true even with an active steward session.
   - Voting works on `https://bioregionalpassport.org/p/tenant-zero/grants/<id>`.
   - Cause: the passport's IndexedDB lives on the canonical wallet origin, and the pod subdomain is a different origin.
   - Suspected files: `apps/web/app/p/[slug]/grants/_components/VotingIsland.tsx:75` and `grants/_lib/voting.ts`. `circulation/_lib/walletCreds.ts` uses the same pattern, so "Open my account" and merchant registration on the pod host are probably affected too; only the platform host was exercised for those.

5. **The steward round list is stale after "Create round".**
   - The status says "Round created as a draft. Open it when it is ready." but the Rounds list still shows "No rounds yet" until a manual reload.
   - Suspected file: `apps/web/app/p/[slug]/grants/steward` page and its create form, which appear to lack `router.refresh()` after create.

6. **Merchant Mode cannot be reached on tenant-zero, and there is no UI to re-present the session after adding `pay:receive`.**
   - Error text: HTTP 404 "We could not find that page." at `/p/tenant-zero/merchant`.
   - Cause: tenant-zero's manifest has `modules.merchant: false`, and `apps/web/app/p/[slug]/merchant/page.tsx:13` 404s on that. The gateway API is not gated, so step 8c was driven through it.
   - After the `pay:receive` VAC was added via Settings, `POST /pay/request` kept returning 403 `MISSING_AUTHORITY` ("This needs authority to receive payments at this enterprise, which your passport does not carry.").
   - The session is only re-presented inside `withSession` when a wallet call fails (`packages/pod-client/src/membership.ts:25-33`). I forced it with `DELETE /api/vta/session` and then an Earn post.
   - The Merchant page tells the owner to "present your passport again", but the wallet has no button that does this.
   - Fix options: turn `modules.merchant` on for the demo pod (in its manifest or tenant-zero seed), and add a "Present again" / refresh-session action in the wallet.

7. **Observations (not blocking; please confirm they are intended):**
   - **Matching can exceed the budget.** A single proposal with a 120-credit budget received the whole 500-credit pool, because no per-project cap was set.
   - **Owners can pay their own enterprise.** The enterprise owner paid their own enterprise, and the payment settled.
   - **Backup warning right after onboarding.** Straight after onboarding, the wallet warns "Your recovery kit does not cover one of your keys yet." The join step creates the persona key after the backup step.
   - **Round dates are shifted by the time zone.** A round opening at 2026-09-22 20:00 local time displays as "Sep 23, 2026", which looks like UTC rendering on the server.

## Verified Working

- Platform landing, health, platform card and pod manifests. The manifests are signed with `eddsa-jcs-2022`.
- Boulder theming via `--bp-primary`, pod nav, and the governance disclosure and tiers.
- The appview API has the Boulder seeds: 8 enterprises and 3 events.
- The canonical wallet origin, full onboarding including the encrypted backup download, and joining as a Visitor, with the explanation sentence.
- The Copy button copies the persona DID in full.
- Operator bootstrap route: Bearer auth, a T3 grant and 17 actions.
- The grant is accepted through Settings → Add a credential → consent → ack → session, and the wallet then shows Steward T3.
- The platform-domain session cookie is honoured on the pod subdomain (steward console).
- The steward creates an attestation event.
- The full simulated ceremony through the real `/api/vta` routes: relay, witness, apply, ack, T1 VACs. The why-this-tier sentences are shown.
- The whole grants round lifecycle works on the platform origin: draft → open → propose → quadratic ballot → close → publish → client-side tally verification. The tier refusal is a single sentence.
- A credit account opens with an L3 limit of 1,000.
- Enterprise registration with a `pay:receive` VAC, a signed payment request, and wallet Pay confirm → authorize → settled receipt, with the balance at -4.
- Earn: the offer was posted (201) after an automatic re-sign-in.
- Cross-pod isolation: `POD_MISMATCH` (403) with a session, and `UNAUTHENTICATED` (401) without one.
- Registry recognition of both pods, and the `issue:MembershipCredential` authorization.

## Production data created (tenant-zero only)

- Steward member `did:key:z6MksViFsZwDsZk82Y9YPPfoNXEpFzafoT1T6uLqQuQEpmQY` (T3, named "E2E verifier").
- Demo second phone (T1).
- Event "E2E verification gathering".
- Rounds:
  - "E2E verification round" (published);
  - "E2E refusal check (Anchor-only proposals)" (left open, no proposals).
- Credit account; enterprise "E2E Verification Stall"; payment receipt 2 (4 credit).
- Offer "E2E verification: bike tune-up".

## Addendum — 2026-09-23, after the final fix wave and peer witnessing (deploy from `daf43b9`)

Smoke run with curl against production after both pods were migrated to `0012`:

| Check | Result |
|---|---|
| `/` and `/api/health` (2 pods, 0 pending migrations) | 200 |
| `boulder.bioregionalpassport.org/p/boulder/map`, `/directory`, `/events` | 200 (directory lists 8 enterprises; events show "Boulder Creek Cleanup + Attestation" with the Attestation gathering pill, Sat Sep 26 10:00 AM MDT) |
| `/p/boulder/grants` and `/p/tenant-zero/merchant` on pod hosts | 307 to the platform origin (wallet-dependent sections, ADR-032) |
| `bioregionalpassport.org/p/tenant-zero/merchant` | 200 (Merchant Mode enabled on the demo pod) |
| `/wallet/witness` | 200 (peer witnessing screen) |
| Security headers | CSP, `X-Frame-Options: DENY`, `nosniff`, referrer policy present |
| `passport bioregion verify boulder` / `tenant-zero` | 7/7 checks pass on production data |

Earlier issues 1–3 (map/directory placeholders, events source) and 6 (merchant off on tenant-zero) are resolved; issue 4 is resolved by the platform-origin redirects; issue 5 (steward list) by re-reading after actions. Open cosmetic item: the two non-attestation seeded events are seeded at 11:00 PM MDT because the seeder uses server local time (`services/appview/src/seed.ts`).
