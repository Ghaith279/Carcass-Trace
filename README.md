# Carcass Trace

Traceability for the butcher shop: every tray carries a label that links it to its carcass, and every Zid order records which carcasses its products came from.

## How it works in the shop

1. **Receive**: weigh the carcass and enter the ear tag, farm, slaughterhouse and weight. The system gives it a number (S1014-01 for sheep, B… beef, C… camel) and prints a carcass label.
2. **Cutting room**: the butcher scans the carcass label, taps the product (or scans its barcode), sets how many trays, and presses **Print labels**. Each tray label shows the product, weight, carcass number, packing date and use-by date, with its own barcode. For mince or mixed products, tick **Mince or mixed batch** and scan every carcass that goes in.
3. **Online packing**: type the Zid order number, scan each tray as it goes in the bag, press **Confirm packed**. The trays leave stock and the carcass numbers are added as a comment on the Zid order, for example `Trace: Lamb leg 1kg: S1014-01 | Lamb mince 500g: S1014-01, S1014-02`.
4. **Shop counter**: scan the trays the customer takes and press **Confirm sale**. You can type the POS receipt number to link them.
5. **Stock**: trays and kg in stock by product, what is expiring or expired, and a button to take trays out of stock (expired, damaged, missing at a stock check).
6. **Carcasses & yield**: kg packed against kg received for every carcass, and the average yield per farm.
7. **Trace**: scan or type anything (tray, carcass, Zid order, receipt, ear tag) to see the whole chain.

## What it is made of

| Part | What it does | Where it runs |
| --- | --- | --- |
| `web/` | The screens staff use | Vercel (or Netlify), free plan |
| `supabase/migrations/…_init.sql` | Database tables and the rules for numbering, labels, sales | Supabase, free plan |
| `supabase/functions/zid/` | Talks to Zid with your Zid keys, which never reach the browser | Supabase Edge Function |

---

## Setup, step by step

You need about an hour. Do the steps in order.

### 1. Supabase (database and staff logins)

1. Create an account at [supabase.com](https://supabase.com) and create a **new project**. Pick the region closest to the shop and save the database password somewhere safe.
2. Open **SQL Editor**, paste the whole of `supabase/migrations/20261014000000_init.sql`, and press **Run**. It should say "Success".
3. Open **Authentication > Sign In / Providers** and turn **off** "Allow new users to sign up". This matters: anyone who can sign up gets full access.
4. Open **Authentication > Users > Add user** and create one login per staff member (email and password). Tick "Auto confirm".
5. Open **Project Settings > API** (or **Data API**) and copy the **Project URL** and the **anon / publishable key**. Put them in `web/config.js`:
   ```js
   export const SUPABASE_URL = 'https://xxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJ…';
   ```
   These two values are safe to publish. Never put the **service_role** key in `config.js`.

### 2. GitHub and Vercel (the website)

1. Create an account at [github.com](https://github.com) and a **new private repository** called `carcass-trace`.
2. Upload this whole folder (drag and drop on the repository page works), including the edited `web/config.js`.
3. Create an account at [vercel.com](https://vercel.com) with your GitHub login, choose **Add New > Project**, and import `carcass-trace`.
4. Set **Root Directory** to `web`, leave the framework as **Other**, and press **Deploy**.
5. Vercel gives you an address such as `carcass-trace.vercel.app`. Open it and sign in with a staff login.

### 3. Zid connection

1. In the **Zid Partner Dashboard** (linked from [docs.zid.sa](https://docs.zid.sa)), create an app. Give it these permissions: **Products read**, **Orders read & write**.
   Ask Zid's app team (appmarket@zid.sa) if they need to approve a private app that only your own store will use.
2. Set the app's **redirect URL** to
   `https://<your-project>.supabase.co/functions/v1/zid?action=oauth_callback`
3. Copy the app's **Client ID** and **Client Secret**.
4. In Supabase, open **Edge Functions > Deploy a new function > Via editor**, name it `zid`, paste `supabase/functions/zid/index.ts`, and deploy.
   Then open the function's settings and turn **off** "Verify JWT" (Zid's sign-in redirect needs to reach it; the function checks staff logins itself).
5. In **Edge Functions > Secrets**, add:
   | Name | Value |
   | --- | --- |
   | `ZID_CLIENT_ID` | from step 3 |
   | `ZID_CLIENT_SECRET` | from step 3 |
   | `ZID_REDIRECT_URI` | the redirect URL from step 2 |
   | `APP_URL` | your Vercel address |
6. In Carcass Trace, open **Settings > Connect Zid**, sign in to Zid and approve. Then press **Load products from Zid**.
7. Still in Settings, set for each product: the animal, the fixed weight (leave empty for products weighed per tray), the shelf life in days, and tick **Button** for the products butchers use most.

### 4. Devices

- **Label printer** (cutting room and receiving): direct thermal, 50 × 30 mm labels by default (change the size in Settings). Install its driver, set it as the PC's default printer, and set its paper size to the label size. Use **chiller or freezer-grade** labels.
- **Skip the print dialog** (recommended for the cutting room): make a Chrome shortcut that opens the app with `--kiosk-printing`, for example
  `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://carcass-trace.vercel.app`
  Labels then print immediately on the default printer.
- **Barcode scanners**: USB or Bluetooth, in keyboard mode, set to send **Enter** after each scan (most do by default). The app saves on Enter.
- Press **Settings > Print a test label** and scan it with the scanner to check both.

---

## Things to check on first use

- **Zid details**: Zid's documentation is incomplete about some header formats and the product list response. The function sends every header style Zid documents. If "Load products from Zid" or opening an order fails, the error message shows Zid's reply; send it over and the function can be adjusted.
- **Order number**: packing uses the order number shown in your Zid dashboard. If Zid's order page uses a different ID than the number you see, opening the order will fail with a "not found" message; the trays are still recorded, and the function can be changed to look orders up by number.
- **Yield** uses each product's fixed weight. If trays are filled slightly over, real yield is a little lower than shown.
- **Stock** is only right if every tray is scanned when it leaves. Do a quick weekly check of the fridge and take missing trays out of stock in the Stock screen.

## Rolling it out

Start with sheep for two weeks (cutting room labels and online packing), check that the trays and yield match reality, then add beef, camel and counter scanning.
