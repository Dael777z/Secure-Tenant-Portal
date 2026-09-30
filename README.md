# Summit Residential Portal: Friday demo

This is the team guide to the copy of our resident portal that we're showing on Friday. It covers what the portal is, how to run it, where things live and how to answer the questions we're likely to get.

For the step-by-step demo script, see **[FRIDAY-DEMO.md](FRIDAY-DEMO.md)**.

---

## What it is, in one paragraph

Summit is a website that property managers and residents share. The manager adds buildings, units and leases, then charges rent and records payments. The resident signs in and sees exactly the same rent record the manager sees. The tagline on the sign-in screen, **"One record, two sides,"** is the whole idea: neither side can quietly change the history. A mistake is fixed by adding a new line that says who fixed it and why, never by editing the old one.

---

## What is built

Designed and built the portal: the idea, the screens, the manager and workflows, and the features
before implementation I used Claude to refine it and to build some of the more technical parts I wanted handled carefully:

- **Security underneath the app.** The database itself keeps each resident's data separate. Even if a page has a bug, it can't show one person's data to another.
- **The locked rent record.** The database refuses to edit or delete rent entries, so corrections have to be added as new lines.
- **No outside code libraries.** The database connection, password handling and web server are written using only what comes with Node.js, so there's less third-party code to trust and keep updated.
- **The one-click launcher.** Start Portal.cmd sets up everything on a Windows PC with no installing.


## How to run it

1. Double-click **`Start Portal.cmd`**. A window opens and the browser goes to **http://localhost:4100**.
2. Sign in:
   - Email: `manager@seniorproject.example`
   - Password: `SeniorProject2026`
3. When you're done, double-click **`Stop Portal.cmd`**.

**To wipe everything typed in while practising,** double-click **`Reset Demo Data.cmd`** then start it again.

**Important:** double-click Start Portal.cmd **once** and wait for the "is running" message. Starting it twice at the same time can break the demo database. If that happens, run Reset Demo Data.cmd.

---

## Where things are

```
Friday Test/
├── Start Portal.cmd       start the portal
├── Stop Portal.cmd        stop it
├── Reset Demo Data.cmd    wipe the demo data and start blank
├── FRIDAY-DEMO.md         the demo walk-through
├── README.md              this file
│
├── apps/web/              what you see in the browser (pages, styles, fonts)
│   └── src/views/         one file per screen, e.g. sign-in.ts
├── apps/api/              the server: sign-in, rent, payments, maintenance
│   ├── src/               the server code
│   └── migrations/        the database simple setup i migrated from a past assignment/project with detail to understand, step by step (001 to 021)
├── packages/shared/       rules both sides share (money, validation)
├── scripts/windows/       the launcher behind the .cmd files
├── var/logs/              log files, created when the portal runs
└── Not Necessary/         files the demo doesn't need; nothing was deleted
```

The demo's database and settings are not in this folder. They're kept in `%LOCALAPPDATA%\ResidentPortal-FridayTest` on the PC running it.

---

## Questions we might get

**What is it built with?**
TypeScript running on Node.js 22, with a PostgreSQL 16 database. There are no outside frameworks or libraries.

**Is it secure? Can a resident see someone else's account?**
No. Each resident's data is kept separate by the database itself, not just by the website, so a bug in a page still can't leak another resident's data. Passwords are stored scrambled (hashed), never as plain text.

**Can a manager change or delete a charge after the fact?**
No. Rent entries can't be edited or deleted. A mistake is fixed with a new correcting entry, and both the manager and the resident can see it, along with who made it and why.

**Are the payments real?**
No. For the demo, payments go through a practice system. An amount ending in **.01** is declined, and **.03** turns into a chargeback. Any other amount succeeds. 

**Does it work on a phone?**
Yes. On a small screen the sidebar becomes a bar at the bottom.

**Where does the data live? Is it in the cloud?**
For the demo it's all on this laptop. The portal is built so a property manager can host it themselves, without a company in the middle holding their tenants' data.

**Why only Dashboard and Properties in the sidebar?**
That's on purpose, to keep the demo focused. The full portal also has rent roll, maintenance, messages, reports and settings.

---

## If something goes wrong

| Problem | Fix |
| --- | --- |
| The browser says the page can't be reached | Start Portal.cmd isn't running. Double-click it and wait. |
| The window stops at "Starting PostgreSQL" or shows an error | Run Stop Portal.cmd, then Reset Demo Data.cmd, then Start Portal.cmd. |
| Signing in fails | Check the email and password above. Capital letters matter in the password. |
| You want a clean slate before presenting | Run Reset Demo Data.cmd. |

Details of any error are in `var/logs/`. `launcher.log` and `api.err.log` are the useful ones.
