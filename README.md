# SOS POS Ticket Loader

A Tampermonkey userscript for **app.sospos.com.au** that turns a pasted block of
tracking-sheet rows into repair tickets, ticket updates, and product sales — then
(optionally) writes the new ticket numbers back into your Google Sheet.

It's the repair-side companion to the **SOS POS Sales Loader** and reuses the same
device/job/name/phone parser. Both run side by side: the Sales Loader sits behind the
teal 🏷️ button, this one behind the indigo 🔧 button.

Current version: **1.3**

---

## What it does

Paste the day's rows (tab-separated, straight from the sheet). Each row is read,
classified off **column D's status**, and shown in a preview grouped by what will
happen to it:

| Kind | When | Action |
|------|------|--------|
| **Ticket** | Repair status, no existing ticket # | Creates a new repair ticket |
| **Update** | Repair status **and** a ticket # already in col C | Opens that ticket, sets status, adds note |
| **Sale** | Product / no device + a price | Stages a walk-in sale line |
| **Not completed** | `REFUND`, `NOTE`, or anything unparseable | Skipped and listed for you to handle by hand |

After each ticket is created it can drop the row's full note text into the ticket's
**Notes** dialog, and capture the new ticket number into the **Results** tab.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new userscript and paste in `sos-pos-ticket-status-loader.user.js`
   (or load it via your TM Script Manager).
3. Open `https://app.sospos.com.au/` — the indigo 🔧 button appears bottom-left.

> The bundled Apps Script at the **bottom of the file** is commented out and never
> runs in Tampermonkey. It's only needed if you want Google Sheets write-back — see
> [Write-back](#google-sheets-write-back-optional).

---

## Daily use

1. Click 🔧 → **Build** tab.
2. Click the drop zone, then paste your rows (`Ctrl+V`).
3. Check the preview. Fix anything in the editable fields (e.g. a quote that needs a value).
4. Click **▶ Start**, then **▶ Next** for each row. The customer, device, issues, PIN,
   DOA, status and quote are filled, the ticket is created, and the note is added.
5. **Results** tab → ticket numbers are captured (editable). Copy or push them back to
   the sheet.

Rows in the **Not completed** group are never auto-built — they're deliberately left
for you.

---

## Column map

The paste is tab-separated and read by 0-based column index. Defaults:

| Column | Index | Meaning |
|--------|-------|---------|
| C | 2 | Existing ticket # (only col C is checked) |
| D | 3 | Status — drives routing |
| E | 4 | Cash |
| F | 5 | EFTPOS |
| L | 11 | Quote |
| — | — | Description = the column **after** a `PIN` cell, else the last non-empty cell |

Adjust these in **Settings → Column map** if your sheet differs. The most common one
to change is the quote column — count the tabs from `A = 0` and confirm `L` is really
index 11 in your paste.

---

## Status map

Column D's text is matched (case-insensitive) against an editable map. Each entry has a
`route` and a target SOS POS status:

- `route`: `ticket` (create repair) · `sale` (product) · `manual` (skip → Not completed)
- `sos`: the text to match against the SOS POS **Status** dropdown (the form defaults to "Repairing")

Defaults:

| Col D code | route | SOS status |
|------------|-------|------------|
| `REFUND` | manual | — |
| `NOTE` | manual | — |
| `SYD/TO SEND`, `SYD`, `TO SEND` | ticket | Repairing |
| `WAITING ON CX` | ticket | Waiting on Customer |
| `BAR` | ticket | Repairing |
| `ORDER`, `PART NOT ORDERED`, `PART ORDERED`, `ORDERED` | ticket | Waiting on Parts |

Edit the JSON in **Settings → Status map**. **The `sos` values must match your real
dropdown option text** — that's the first thing to check if statuses aren't being set.

---

## Quote handling (column L)

- A **number** in col L → used directly as the quote amount.
- The word **"quote"** in col L → the row gets an inline `$` input in the preview. Leave
  it blank and a small **Quote amount** popup appears at build time with **Use this / Skip**.
- Quote isn't a required field, so skipping just leaves it at 0.

---

## Google Sheets write-back (optional)

Closes the loop so you don't paste ticket numbers back by hand. The userscript sends
finished tickets to a small Apps Script web app deployed on your sheet, which matches
each row **by its description text** and writes the ticket number into col C (and status
into col D).

### One-time setup

1. In your sheet: **Extensions → Apps Script**.
2. Copy the Apps Script block from the bottom of `sos-pos-ticket-status-loader.user.js`
   (between the `BEGIN APPS SCRIPT` / `END APPS SCRIPT` markers), strip the leading
   `// ` from each line, and paste it into a new Apps Script file.
3. Edit the `CONFIG` block — most importantly **`DESC_COL`** (the column your description
   actually sits in). `TICKET_COL` is `C` and `STATUS_COL` is `D` by default.
4. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**.
   Copy the `/exec` URL. (Visiting it in a browser should return `{"ok":true,...}`.)
5. In the script: **Settings → Sheet write-back** → pick **Manual** or **Auto**, paste the
   URL, optionally set a shared secret (must match the Apps Script `SECRET`). Save.

### Using it

- **Manual:** Results tab → **⬆ Push to Sheet**.
- **Auto:** pushes by itself when a batch finishes.
- **Copy:** the old paste path is still there (**📋 Copy** → outputs ticket numbers, one per line).

**Matching caveats:** rows are matched by exact description text (whitespace-normalised).
If two rows share an identical description, the first unused one is written. The text must
match what's in the sheet.

---

## Settings reference

| Setting | What it does |
|---------|--------------|
| Add row note to Notes dialog | Opens Notes and pastes the row note after creating a ticket |
| Default DOA answer | Which DOA radio to tick (No / Yes) |
| Smart note parser | On = extract device + issues; Off = use raw description |
| Step delay (ms) | Pause between automated actions — raise it if the app lags |
| Sheet write-back | Off / Manual / Auto |
| Apps Script Web App URL | The `/exec` deployment URL |
| Shared secret | Optional, must match the Apps Script `SECRET` |
| Column map (JSON) | 0-based column indices |
| Status map (JSON) | Col D code → route + SOS status |

Settings persist via Tampermonkey storage. **Reset maps** restores the default column
and status maps (then Save to keep).

---

## Known limits / best-effort bits

These interactions were written to the standard radix/shadcn pattern but the source
DOM for the popups wasn't fully captured, so they may need a tweak against the live app:

- **Issues picker** — required field. If a selection doesn't stick, *Create Ticket* stays
  disabled and the script says so.
- **Device search** and **Status dropdown** — best-effort option matching.
- **Update existing ticket** (`openTicketByNumber`) — a stub. Opening an existing ticket
  needs the board search / row-open DOM wired in; until then the Update path can't open
  the ticket on its own.

If any of these misbehave, grab the relevant popup's HTML and the matching helper can be
hardened.

---

## Files

- `sos-pos-ticket-status-loader.user.js` — the userscript (Apps Script bundled at the bottom).

## Changelog

- **1.3** — bundled the Apps Script into the userscript as a paste-once comment block.
- **1.2** — Google Sheets write-back (Copy / Push / Auto) via Apps Script web app.
- **1.1** — existing ticket from col C only; refunds & notes skipped as *Not completed*;
  quote moved to col L with a popup when the cell reads "quote".
- **1.0** — initial: status routing, ticket creation, notes, sales staging, results.
