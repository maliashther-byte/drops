# Key Drop Bot

Discord.js v14 bot for distributing shared website/license-key inventory
across servers with tiered quantities and cooldowns. Built with MongoDB
(Mongoose).

## Features

- `/setup` — admin wizard: drop channels, embed branding, 5 tiers (roles,
  daily limits, cooldowns, prices, shop descriptions, and secure-action limits),
  and CAPTCHA/AI settings. **Quick start** configures default drop channels in
  one selection; use the built-in web dashboard for the full settings editor.
- `/ca  tegories` — opens a button panel to add, edit, remove, list, and inspect
  shared categories. The View inventory action displays item values and claim
  status privately, with paging.
  Categories and key/link stock are shared by every server. Removed
  categories stop drops; their stock stays visible in `/database` with
  a `-deleted` suffix. On first startup after updating, old default
  categories are removed, custom categories are merged, and eligible
  unclaimed stock is moved into shared inventory.
- `/dropconfig` — opens a private admin panel to configure channels,
  up to 10 item generators, and CAPTCHA settings. Each generator has its own
  colored embed, and the product is claimed only from its configured drop
  channel. The bot does not post a shared banner across every channel.
  Each generator maps a custom command name to a
  shared category. After submitting Add or Edit, a private tier panel lets
  you set each tier's item quantity separately: click Free, Bronze, Silver,
  Gold, or Diamond, enter one number from 0 to 500, and save. A value of `0`
  disables that tier; new generators start at 1 item for each tier.
  Add/Edit also supports a product-specific cooldown in minutes (0–10,080)
  after each use across channels. Leave it blank to use the member's tier
  cooldown; in Edit, enter `default` to restore that behavior.
  In the private product settings panel, set a per-product daily claim cap
  (1–1,000), choose `unlimited` to disable the cap while keeping cooldowns,
  or choose `default` to use the member's tier limit. **Tier cooldowns** sets
  individual cooldowns for Free through Diamond; `default` uses the product
  cooldown if set, otherwise the member's tier cooldown.
  The `/dropconfig` owner-only controls can clear all cooldowns for a selected
  member or send them a one-use cooldown-refresh reward. That reward can also
  be stocked as a `cooldown-refresh` category drop; its DM button activates
  once and expires after seven days if unused.
  Product names are labels used for the configured generator command. Each product has a separate
  2–32 character command name (you may enter it with or without `!`), and
  members type `!<command>` in the drop channel assigned to that generator;
  product commands do not work in other channels. Use `/dropbutton` to
  publish a custom embed with a working claim button for a generator. Set its
  title, description, button label, and optional HTTPS image; the dashboard's
  Generators editor can save and publish the same design. The button uses the
  generator's tier quantities and product cooldowns; its per-generator daily
  cap overrides the channel/tier button cap. Configure channel/tier button caps
  and cooldowns with `/dropbuttonlimits` or in the dashboard's Channels
  section. CAPTCHA frequency follows that channel's per-tier verification
  interval. Re-publishing replaces the previous embed, and inactive/old buttons
  cannot issue claims. Old bot-created sticky product menus are removed on startup;
  the bot does not repost them. `/setup` sets
  each tier's cooldown, and that cooldown applies to the generator command
  across channels rather than being reset per channel.
  Image CAPTCHA verification can be required every 1–20 successful claims. **Drop a
  tier** posts a role-reward box with a chosen duration; timed tier roles are
  automatically removed when access expires. Configure tier roles in `/setup`
  first.
- `/shop` — administrator-only command that posts a tier shop embed with
  configured prices and explanations. Its purchase button gives the member
  private tier choices, then opens a private ticket visible to them and the
  server owner. Payments are arranged in the ticket; the bot does not process
  payments. The panel separately lists enabled free credit-earning methods and
  gives members buttons to claim daily and verified-invite credits. Members can
  also use **Explain a product** to inspect availability, cooldowns, and credit
  cost before claiming.
- `/shoptrial` — administrator-only per-tier trial toggle and duration
  (1–8,760 hours). The matching shop button grants a timed tier role; each
  member can claim one tier trial per server, ever. The dashboard's Tiers tab
  provides the same controls. The bot needs Manage Roles and a higher role
  position than the trial role.
- `/wallet` — privately view your credits and daily/invite reward status in
  this server.
- `/creditconfig` — configure server-local starting balances and daily,
  message, verified-invite, and AI activity-monitoring settings. Pick a `setting` and provide the
  corresponding option (`amount`, `hours`, `enabled`, `channel`, or `tier`).
  Message rewards can be limited to selected channels and tiers and observe a
  cooldown and daily cap. Invite rewards exclude bots and require the invitee
  to stay for the configured period.
- `/creditgrant` — administrator-only audited credit grant to a server member.
- `/dropcost` — administrator-only per-claim credit cost for a product
  generator; set `credits` to `0` to make it free. The dashboard's Generators
  tab offers the same setting. Credits are only used for product claims, not
  shop tiers.
- `/event` — administrator-only timed announcement for a selected shared
  category (1–10,080 minutes). Optionally ping `@here` once when it starts.
  The announcement is automatically marked ended when its duration expires,
  including after a bot restart. Claims continue to use normal tier access,
  stock, and cooldown rules.
- Categories may use type `cooldown-refresh` to make a special drop reward.
  A winner receives an **Activate (expires in 1 week)** DM button; using it
  clears that member's product and regular drop cooldowns in this server.
- `/database` — opens a button panel to review stock counts and add, remove,
  edit, bulk paste, or refresh inventory. `.txt` file uploads are also
  available by invoking `/database` with both a category and file
  (optionally AI-categorized). File uploads support up to 100,000 non-empty
  lines and 25 MB per command, inserted in batches of 1,000. Uploads over
  5,000 lines go directly into the selected category instead of AI
  categorization; split larger files and run `/database` again for each part.
- `/stock` — administrator-only command that posts one public live stock
  counter in the current channel. It refreshes every 10 seconds, immediately
  after successful claims, and when someone presses **Refresh now**. The
  public website at `/stock` shows category counts without exposing item values.
- `/help` — paginated guide, shows the user's tier, remaining drops today,
  cooldown status, and upgrade prices.
- `!drop [category|random] [amount] [yes|no]` — start a loot box from a
  configured drop channel. `amount` is 1–25 and defaults to 1; `random` chooses uniformly from
  categories the member can access that have enough stock. `yes` requires a
  CAPTCHA, `no` skips it, and leaving the option out follows the server default.
  Items within each category are selected randomly from available stock.
  The box is posted in the first configured drop channel (or the current
  channel if none is set). Users click its 🎁 button to claim the requested
  quantity; any required CAPTCHA is
  private, and the first successful claim is shown on the box in red.
  Rewards are DMed and never shown in the public channel.
- `!<product-name>` — claims the configured product directly; item quantity
  and cooldown depend on the member's tier.
- Key/link DMs include a **Secure key or link** action. Until pressed, the
  item stays reserved in shared inventory. Each tier controls how many items
  one press permanently removes; a limit of `0` automatically removes items
  without a button (Diamond is the default bypass tier).

## Project layout

```
key-drop-bot/
├── package.json
├── .env.example
├── index.js
├── dashboard/
│   ├── server.js           # Discord OAuth2 admin dashboard API
│   └── public/             # responsive settings editor
├── config/
│   └── constants.js        # default tier + drop-type config
├── schemas/
│   ├── Guild.js             # per-guild config and product settings
│   ├── User.js               # legacy per-user-per-guild usage
│   ├── Stock.js               # legacy per-server inventory for migration/history
│   ├── GlobalStock.js         # shared key/link inventory
│   ├── GlobalCategory.js      # shared category definitions
│   ├── CooldownReward.js      # expiring one-use cooldown refresh rewards
│   ├── TimedEvent.js          # event announcements awaiting expiry
│   ├── DropUsage.js           # per-user/channel claim limits and cooldowns
│   ├── SecureDelivery.js      # reserved items awaiting secure removal
│   ├── StockCounter.js        # persisted public stock-counter message
│   └── TierGrant.js           # timed tier-role grants
├── handlers/
│   ├── commandHandler.js      # loads & registers slash commands
│   ├── eventHandler.js        # loads event files
│   ├── deployCommands.js      # registers slash commands with Discord
│   ├── aiHandler.js           # OpenAI bulk categorization
│   ├── dropEngine.js          # eligibility, CAPTCHA gate, atomic claim, delivery
│   └── tierGrants.js          # grant and expire timed tier roles
├── commands/
│   ├── setup.js
│   ├── categories.js        # global category management
│   ├── dropconfig.js        # channel, product, and tier setup
│   ├── event.js             # timed shared-category announcements
│   ├── shop.js              # tier shop and private purchase tickets
│   ├── database.js
│   └── help.js
├── events/
│   ├── ready.js
│   ├── interactionCreate.js    # slash commands + buttons/menus/modals
│   └── messageCreate.js        # !drop prefix command
└── utils/
    ├── embeds.js
    ├── logger.js
    ├── permissions.js          # tier resolution, daily-limit & cooldown checks
    ├── stockCounter.js         # live Discord counter updates
    ├── stockSummary.js         # shared category-count aggregation
    ├── quizState.js            # in-memory store for active CAPTCHA drops
    └── captcha.js              # local CAPTCHA image generation
```

## Setup

```bash
npm install
# if key-drop-bot/.env does not already exist:
cp key-drop-bot/.env.example key-drop-bot/.env
# otherwise add any missing variables to the existing file
npm run deploy-commands   # registers the slash commands
npm start
```

Run `/setup` and choose **Quick start** to select drop channels using defaults.
Add an item generator with `/dropconfig`, or open the dashboard for channels,
generators, tier settings, shared categories and inventory, bulk upload with
optional AI categorization, timed category events, timed tier rewards, member
cooldown tools, shop publishing, appearance, and CAPTCHA/AI settings. Shared
categories and inventory changes affect every server running this bot.

The dashboard and `/copysetup` can copy selected setup sections from another
server. Copying requires Administrator permission in both the source and target
servers. Leaving every `/copysetup` section switch off copies all sections.
Channel and product setup is replaced only when that section is selected. It
reuses or creates matching channels, maps tier roles by name, leaves unmatched
roles unassigned, and never copies shared categories/inventory. Credit rules
and product costs are copied without copying wallet balances,
transaction histories, or published message IDs. The dashboard's Credits &
stats section includes wallet and transaction summaries, audited credit grants,
and AI suspicious-activity alerts. The AI builder supports declarative channel,
generator, tier, credit, and embed settings. It asks questions, presents a
Gemini-reviewed preview, and deploys only after administrator confirmation.
Deployed AI changes are recorded with before/after snapshots and can be undone
when no later configuration changes conflict. Gemini safety analysis uses
anonymized aggregate activity counts only, never message text or member IDs;
alerts are advisory and never trigger automatic punishment.

### Admin web dashboard

Set `DISCORD_CLIENT_SECRET` and `DASHBOARD_REDIRECT_URI` in `.env`. Add the exact
redirect URL to the Discord application's OAuth2 redirect list. The dashboard
uses Discord sign-in and only lists servers where the signed-in user is an
Administrator and the bot is present. It starts with the bot on port `3000`
(`PORT` or `DASHBOARD_PORT` can change this) and binds to `0.0.0.0` by default.
Use HTTPS for remote access and set `DASHBOARD_COOKIE_SECURE=true`. The dashboard
honors the hosting platform's `PORT` variable before
`DASHBOARD_PORT`, so the dashboard port can be detected and forwarded by the
host. Set `DASHBOARD_REDIRECT_URI` to the public HTTPS callback URL in
production and register it in the Discord Developer Portal.

## Required environment variables

See [key-drop-bot/.env.example](./key-drop-bot/.env.example).
`OPENAI_API_KEY` and the dashboard OAuth settings are optional. CAPTCHA images are generated
locally; without an API key, bulk uploads go into the selected category instead
of being AI-sorted.
`GEMINI_API_KEY` is optional and enables the dashboard AI builder and activity
monitoring. Set `GEMINI_MODEL` to override the default `gemini-2.5-flash` model.
Activity monitoring also requires selecting activity channels in Credits & stats
and enabling AI safety analysis for the server. Without the Gemini key, the
builder and analysis remain unavailable while normal bot features continue.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Bot won't log in | Bad `DISCORD_TOKEN` | Regenerate token in Dev Portal |
| `/setup` etc. not showing up | Commands not deployed, or deployed as global (1hr cache) | Run `npm run deploy-commands`; use guild deploy for instant testing |
| Mongoose connection timeout | Bad `MONGO_URI` or IP not whitelisted in Atlas | Check Atlas Network Access |
| Drops always say "out of stock" | No stock uploaded for that category, or category name mismatch | Check `/database` |
| CAPTCHA image is not shown | Bot cannot attach files in the channel | Allow the bot to send messages and attachments |
| User can't be DMed their key | DMs closed | Enable DMs and retry; shared keys are not posted publicly |
