# UniSprint

UniSprint (formerly WeHelp, and the same project as the `qabul-uz` repo) sells a
done-for-you study-in-Korea application service to Uzbek families and runs the
agency work behind it. It has four parts:

| Page | Who uses it | What it does |
|---|---|---|
| `landing.html` (`/`) | Families | The sales page in Uzbek, Russian and English: the service, packages and prices in so'm, a countdown to the next intake deadline, a visa-restriction checker and the request form. Requests land on the agency board as leads. Add `?src=telegram` (or any word) to links you post, and the lead card shows where it came from. |
| `index.html` (`/app`) | Students | Explore 20 Korean universities, compare them, build a profile, track colleges. Works offline from the file. When served by the UniSprint server, students can sign in and their data is saved to their account. Also has a lead form and a visa-restriction checker. |
| `agency.html` (`/agency`) | The agency team | A board with every student as a card: lead → documents → applied → admitted → visa → arrived. Each card has applications, per-university document checklists, invoices, a family link and a timeline. |
| `parent.html` (`/parent.html#<link>`) | Parents | A private progress page in Uzbek, Russian or English, with Click and Payme payment buttons and a Telegram link for updates. No account needed. |

The backend is in [`server/`](server/): Node.js, Express and Postgres.

## Packages, prices and contacts

Packages, prices, deposits and the intake deadlines shown on the sales page live in
[`server/data/packages.json`](server/data/packages.json). Edit that file and redeploy
to change them. On the agency board, a student's Payments section can fill an invoice
from a package (deposit, balance or full price). Contacts shown on the sales page come
from `CONTACT_TELEGRAM`, `CONTACT_PHONE` and `CONTACT_INSTAGRAM`; when they are empty,
the page shows only the form.

## What the backend does

- **Accounts.** Admins and agents sign in to the board. Students create an account with an invite code from their card, which links the login to the card.
- **Agency board.** Students, applications, document checklists, notes and a timeline. Moving a card to a new stage notifies the student and parents on Telegram. Moving to *Visa* adds the visa checklist.
- **Per-university checklists.** Every new application copies a checklist: the university's own list if one is set on the Universities tab, otherwise the default degree or language-program list in `server/data/document-templates.json`.
- **IEQAS / visa flag.** Every university has a status: IEQAS excellent, certified, not certified, restricted or not checked yet. The 20 universities restricted in September 2026 (16 for D-2 degree visas, 4 for D-4 language visas, until 31 Aug 2027) are preloaded from the [JoongAng Daily report](https://www.koreajoongangdaily.com/korea/20-korean-universities-face-visa-restrictions-for-international-students/12846157). Adding an application to a restricted school asks for confirmation, and the card shows a warning. The 20 catalog universities start as *not checked yet*: confirm each one on the official Study in Korea list and set it on the Universities tab.
- **Payments.** Invoices in so'm. Parents pay with Click (SHOP API: Prepare/Complete) or Payme (Merchant API: JSON-RPC). Staff can also mark cash or bank payments, cancel unpaid invoices, and record refunds.
- **Telegram reminders.** Once an hour between 09:00 and 21:00 Tashkent time, students, parents and the agent get one message each listing missing documents and draft applications due within 14, 7, 3, 1 and 0 days, and overdue ones. Each item is reminded once per step.

## Run it locally

You need Node 20+ and Postgres.

```bash
cd server
npm install
export DATABASE_URL=postgres://postgres@localhost/unisprint
npm run create-admin -- you@example.com 'a-strong-password' "Your Name"
npm start            # http://localhost:3000, board at /agency
```

The database tables and the university data are created on start. Tests use a separate database that they wipe:

```bash
createdb unisprint_test
TEST_DATABASE_URL=postgres://postgres@localhost/unisprint_test npm test
```

## Deploy

`render.yaml` sets up the web service on Render. Set `DATABASE_URL` to a durable Postgres: Render's free Postgres is deleted after 30 days, so don't use it for real students. Add `?sslmode=require` to the URL when the database is outside Render's private network. The tables are created on start. Then create the first admin from the service's Shell (paid plans) or from your computer with the external database URL: `DATABASE_URL=... npm run create-admin -- email password "Name"`.

### Settings

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Always |
| `CONTACT_TELEGRAM`, `CONTACT_PHONE`, `CONTACT_INSTAGRAM` | Contacts on the sales page |
| `PUBLIC_URL` | Payment return links, e.g. `https://unisprint.uz` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Telegram. Create the bot with @BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Any random string. Then point the bot at the server once: `curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=$PUBLIC_URL/api/telegram/webhook/$SECRET"` |
| `PAYME_MERCHANT_ID`, `PAYME_KEY` | Payme. In the Payme merchant cabinet set the endpoint to `$PUBLIC_URL/api/payments/payme` and the account field to `invoice_id`. Use `PAYME_CHECKOUT_URL=https://checkout.test.paycom.uz` with the test key while testing. |
| `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` | Click. Prepare URL: `$PUBLIC_URL/api/payments/click/prepare`, Complete URL: `$PUBLIC_URL/api/payments/click/complete`. |
| `REMINDERS=off` | Turns off the hourly reminder pass. `npm run remind` runs it once by hand. |

Without the Telegram or payment settings, those features stay hidden or log instead of sending, and everything else works.

## API overview

- `POST /api/auth/login`, `/logout`, `/register` (invite code), `/password`, `/telegram-link`; `GET /api/auth/me`
- `GET /api/board/summary`, `GET|POST /api/board/students`, `GET|PATCH|DELETE /api/board/students/:id`, plus `/notes`, `/invite`, `/parent-link`, `/applications`, `/documents`, `/visa-checklist`, `/invoices`
- `PATCH|DELETE /api/board/applications/:id`, `/api/board/documents/:id`; `PATCH /api/board/invoices/:id`; `GET|POST /api/board/staff`
- `GET /api/universities` (public), `GET /api/universities/check?name=` (public), `POST|PATCH /api/universities/:id`, `GET|PUT /api/universities/:id/documents`
- `GET /api/parent/:token` (public, private link)
- `GET /api/me/progress`, `GET|PUT /api/me/state` (students)
- `POST /api/leads` (public form)
- `POST /api/payments/payme`, `/api/payments/click/prepare`, `/api/payments/click/complete`, `/api/telegram/webhook/:secret`

University figures on the student site come from public sources. Check them, and each school's visa status, before advising a student.
