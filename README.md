# EvAN Reinspection Assistant

Chrome extension (Manifest V3) that automates reinspection data entry into EvAN, plus a
one-hand hotkey for manual quick-fills.

## Load it (unpacked)

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this `evan-reinspection-assistant` folder.
4. Open EvAN in a tab, then click the extension icon to open the popup.

## Quick-fill hotkey

With EvAN's building-edit screen open, press `Ctrl+Shift+Q` to fill the boilerplate fields
(inspector code, inspection code, today's date, reinspection reason/process, MDA/Over Val/RCN
Override zeroed out). It does not click Calculate or Save. Toggle it on/off from the popup,
and set your inspector code there too (it's remembered).

## Bulk run

1. In the popup, set your inspector code.
2. Upload the reinspection spreadsheet. The extension guesses which columns are PAN,
   description, net condition and building count; confirm/correct them if needed.
3. Add your groupings (grouping number + a short keyword matched against the description
   column, case/accent-insensitive substring match). Add more rows for synonyms.
4. Click "Start bulk run". Only rows with a building count of exactly 1 are processed for now;
   everything else is skipped and logged with a reason. Progress keeps updating even if you
   close the popup.
5. When it finishes, an xlsx with PAN / comments / chosen grouping / value downloads
   automatically (columns: PAN, Comments, Chosen Grouping, Value, Status).

## Known gaps / assumptions to verify against a real record before trusting this at scale

- **PNOT note save button**: no stable id was given for whatever confirms the note popup, so
  the automation looks for a visible Save/OK/Submit-ish button inside that popup and clicks it.
  If that guess is wrong for a given screen state, the row's Status column will say so
  ("PNOT note may need manual confirmation") — spot check a few of those.
- **Net condition units**: the spreadsheet stores it as a fraction (e.g. `0.7`), the EvAN field
  wants a whole percent (`70`). The extension multiplies by 100 when the value is `<= 1`. Worth
  double-checking on the first real run.
- **Multi-building PANs are skipped entirely** (not just building #1) per your instruction —
  they show up in the export with `multi-building, skipped for now`.
- Grouping matching is a case/accent-insensitive substring check against the description
  column. If a keyword is too generic it can match more than one grouping row — those get
  skipped as "ambiguous" rather than guessed.
