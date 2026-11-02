MarketPulse AI V3.1 — IG DEMO ONLY

IMPORTANT: Experimental software, NOT validated against an IG order placement response. No profitability claim. Back up V3 before replacing files.

INSTALL: Replace server.js, package.json and public/index.html in your GitHub repository; deploy latest commit on Render. Keep existing IG credentials in Render Environment. Add ADMIN_TOKEN (a long random password).

DEFAULT: ENABLE_DEMO_ORDERS=NO. Orders are LOCKED. To arm, the operator must first verify IG demo instrument contract metadata, min deal size, point size, cash value per point in account currency, stop distance and account currency. Only then set: ENABLE_DEMO_ORDERS=YES_I_ACCEPT_DEMO_RISK, VERIFIED_EPIC=<exact demo epic>, VERIFIED_CASH_PER_POINT_PER_CONTRACT=<verified monetary amount>, VERIFIED_PRICE_POINT_SIZE=<verified price movement per point>. NEVER guess these values. Wrong values can create unintended exposure. Redeploy after changing Render variables.

After redeploy, auto starts PAUSED. Enter ADMIN_TOKEN when using the dashboard Enable button. Demo orders use 0.5% balance-based planned stop risk, maximum 2 open positions, minimum heuristic score 70, 1.5 reward/risk, and a 2% daily BALANCE snapshot pause. Actual loss may exceed estimates due to slippage, spreads, fees, gaps and non-guaranteed stops. Balance guard does not monitor unrealised P/L or true daily equity drawdown.

Only demo-api.ig.com is used. It is not possible to use live host via environment configuration. Orders use attached non-guaranteed stop/limit. No active exit manager: IG manages exits through attached orders. Pause does NOT close existing positions. No close-all button. No persistence: signals/deduplication reset after restart, and UTC balance baseline resets on restart. Do not run multiple Render instances. Do not expose the dashboard publicly: ADMIN_TOKEN guards mutation endpoints, but read-only routes expose account data; use Render private network or additional access controls.

Safety: any order error or uncertain confirmation pauses auto mode and requires checking the IG demo account before rearming. First validate with a small demo account and monitor IG positions manually.
