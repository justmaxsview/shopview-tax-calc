# ShopView Tax Calculator

A Chrome extension that shows the estimated sales tax for a US ZIP code or tax region, or a Canadian
province. It opens in Chrome's side panel and stays open while you work.

---

## How to install

1. Download **[shopview-tax-calc.zip](https://justmaxsview.github.io/shopview-tax-calc/shopview-tax-calc.zip)**.
2. Unzip it into a folder you'll keep, for example `Documents/ShopView Tax Calculator`.
   Don't delete or move this folder later; Chrome runs the extension from it.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked** and choose that folder.
4. Click the puzzle-piece icon in the toolbar and pin **ShopView Tax Calculator**.
5. Click the icon (or press **Alt+Shift+T**) to open it. Close it with **Close** or the panel's X.

## How to update the extension

When a new version is out, you'll get a desktop notification, and the bottom of the panel says
"Version X is available".

1. Download **[shopview-tax-calc.zip](https://justmaxsview.github.io/shopview-tax-calc/shopview-tax-calc.zip)** again.
2. Unzip it **into the same folder**, replacing the old files.
3. In `chrome://extensions`, click **Reload** on ShopView Tax Calculator.

Tax data updates don't need any of this. They reach everyone automatically.

---

## How to update tax data

Tax data lives in the **csv** folder of this repo. When a file there changes, every installed
extension downloads the new rates by itself within 24 hours, or right away when someone clicks
**Sync now**.

### US states

Each state has one file, named like `TAXRATES_ZIP5_GA202611.csv` (state `GA`, year `2026`,
month `11`).

1. Get the new monthly file for the state. **Keep the file name exactly as it is.**
   Don't open and re-save it in Excel, which can drop leading zeros from ZIP codes.
2. Open the **csv** folder in this repo, click **Add file → Upload files**, and drag the file in.
3. Click **Commit changes**.
4. **Delete that state's old file.** Open it, click **⋯** (top right), choose **Delete file**, and
   commit. Each state must have exactly one file.

You can upload several states at once, then delete each one's old file.

Schedule:

| What | When |
|---|---|
| States where we have customers | Monthly, in the first week of the month |
| All states | Quarterly: January, April, July, October |

### Canada

Canada is one file, `CANADA_SALES_TAX_<YYYYMM>.csv`, with one row per province:

```
Province,Code,GST_HST,PST
Ontario,ON,13%,N/A
British Columbia,BC,5%,7%
...
```

- **GST_HST:** the GST rate (5%), or the full HST rate where the province charges HST (for example
  Ontario 13%).
- **PST:** the provincial rate, `0%` where there's none, or `N/A` where the province charges HST.

To change a rate, open the file in the **csv** folder, click the **pencil** (Edit), change the
number, and click **Commit changes**. For a new month, rename the file to the new month on the
same screen.

### Check that it went live

1. Click the **Actions** tab. The newest **Publish** run should show a **green check** within a
   minute or two.
2. In the extension, click **Sync now**. The bottom of the panel shows which states were updated.

If the run shows a **red X**, nothing was published and everyone keeps the previous rates. Click
the run, then **build**, then **Validate and build rate files** to see what's wrong, for example:

- `Two files for GA`: delete the older GA file.
- `headers don't match`: the file was changed or re-saved. Get the original file again.
- `file name must be TAXRATES_ZIP5_<ST><YYYYMM>.csv`: rename it back to the original name.

Fix it and commit again; it publishes on its own.

To undo a bad update, upload the previous file again and delete the bad one.
