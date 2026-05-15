# Changelog

## [0.1.15](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.14...wallet-v0.1.15) (2026-05-15)


### Bug Fixes

* override fast-uri to ^3.1.2 to clear the publish audit gate ([857d98a](https://github.com/KeeperHub/agentic-wallet/commit/857d98a40e2feac2d25aa5a3fc8b6deded703961))
* override fast-uri to ^3.1.2 to clear the publish audit gate ([f4f8c06](https://github.com/KeeperHub/agentic-wallet/commit/f4f8c0627a712a11c2279bc9751f3008b9634f0d))

## [0.1.14](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.13...wallet-v0.1.14) (2026-05-14)


### Bug Fixes

* buffer feedback gas preflight and add force-broadcast passthrough ([fa0d280](https://github.com/KeeperHub/agentic-wallet/commit/fa0d2804ff5ee4fd7683cfc726dfc329f3d220cd))
* preflight feedback gas before submission ([3cfcc0f](https://github.com/KeeperHub/agentic-wallet/commit/3cfcc0fc411425b42fa6d47da17a17a8d1d52b95))
* preflight feedback gas before submission ([adcb706](https://github.com/KeeperHub/agentic-wallet/commit/adcb706491ab77f908166f85e69cd035217f0c80))

## [0.1.13](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.12...wallet-v0.1.13) (2026-05-07)


### Features

* add feedback CLI command and MCP tool ([38c7cc3](https://github.com/KeeperHub/agentic-wallet/commit/38c7cc31c2684adceff2ed91587a992bbbd8ccf1))

## [0.1.12](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.11...wallet-v0.1.12) (2026-05-02)


### Features

* **mcp:** add keeperhub-wallet stdio MCP server ([fe60c7b](https://github.com/KeeperHub/agentic-wallet/commit/fe60c7ba0fbd0d619bec1d3b3814c4355c5f4df6))
* **mcp:** add keeperhub-wallet stdio MCP server ([c344f4b](https://github.com/KeeperHub/agentic-wallet/commit/c344f4b21d887cd9c7e3992730223241164b3994))


### Bug Fixes

* **mcp:** review feedback — provision race, corrupt-config, error envelopes ([29391cc](https://github.com/KeeperHub/agentic-wallet/commit/29391ccd6b8d9e9932248712b19a8257715f6667))
* **mcp:** security/DX/ops review feedback — atomic writes, timeouts, header allowlist ([bfbac19](https://github.com/KeeperHub/agentic-wallet/commit/bfbac191372953bafb4cf6bf8e2c7778a88cf114))

## [0.1.11](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.10...wallet-v0.1.11) (2026-05-02)


### Bug Fixes

* **skill-install:** detect npx-cache execution + drop stale skill version ([494d033](https://github.com/KeeperHub/agentic-wallet/commit/494d033b7282a320b1356a750b6343ab8cbd4570))
* **skill-install:** detect npx-cache execution to avoid stale hook command ([951e074](https://github.com/KeeperHub/agentic-wallet/commit/951e074a28fd45f431c8a9f7100547f65ff5b5ae))
* **skill-install:** widen transient-cache detection beyond npx, gate POSIX-only tests ([98154d4](https://github.com/KeeperHub/agentic-wallet/commit/98154d4beed08f772f2e8141b3953fcf73bc42f6))

## [0.1.10](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.9...wallet-v0.1.10) (2026-05-02)


### Bug Fixes

* **skill:** expand description with brand name + explicit trigger phrases ([1f707b1](https://github.com/KeeperHub/agentic-wallet/commit/1f707b1ea6c7dbb84501aecb2c9078a1ccc1302a))
* **skill:** expand description with brand name + explicit trigger phrases ([b042d20](https://github.com/KeeperHub/agentic-wallet/commit/b042d20e98c1619b354af23b8a68542f8f6e7551))

## [0.1.9](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.8...wallet-v0.1.9) (2026-05-01)


### Bug Fixes

* **hook:** pass through MCP calls with no payment shape (KEEP-392) ([c9f05d5](https://github.com/KeeperHub/agentic-wallet/commit/c9f05d50989b4bdd6eaa834776ad06f39df7b886))
* **hook:** pass through MCP calls with no payment shape (KEEP-392) ([5e53b1b](https://github.com/KeeperHub/agentic-wallet/commit/5e53b1b48371ff7393874e6995805daaa09bc91f))
* **skill-install:** per-hooks[] filtering preserves foreign siblings ([7bac748](https://github.com/KeeperHub/agentic-wallet/commit/7bac748f234ee95c9dc134e3c82d38c04d6c32eb))
* **skill-install:** pin npx version and narrow de-dup marker (review feedback) ([e6b3c19](https://github.com/KeeperHub/agentic-wallet/commit/e6b3c1945ebdceeffaafd4eb2586c04a9950c9da))
* **skill-install:** resolve hook command at install time so npx flow works ([0161181](https://github.com/KeeperHub/agentic-wallet/commit/0161181a2784e3e140146d145b4f3997f3e16105))
* **skill-install:** resolve hook command at install time so npx flow works ([b9c3cb1](https://github.com/KeeperHub/agentic-wallet/commit/b9c3cb17b634848770ad3e471ffd000a70df678e))

## [0.1.8](https://github.com/KeeperHub/agentic-wallet/compare/wallet-v0.1.7...wallet-v0.1.8) (2026-04-29)


### Features

* **balance:** drop off-chain credit leg (v0.1.3) ([590641c](https://github.com/KeeperHub/agentic-wallet/commit/590641c995896480d82f133163d31716c94c0f3e))
* **balance:** drop off-chain credit leg, ship on-chain-only balance (0.1.3) ([ea8ff17](https://github.com/KeeperHub/agentic-wallet/commit/ea8ff17bdbc6293d5c51d8ec338912e532c29902))
* initial release of @keeperhub/wallet v0.1.0 ([5366957](https://github.com/KeeperHub/agentic-wallet/commit/536695788e8170bc68a4483dde64cc8d4a354596))
* **payment-hint:** add paymentHint protocol selection override (KEEP-361) ([df8b5a7](https://github.com/KeeperHub/agentic-wallet/commit/df8b5a72d17c136236d24b166cb6642dc2e56f02))
* **payment-signer:** forward body+headers on 402 retry; add signer.fetch() (0.1.6) ([3235977](https://github.com/KeeperHub/agentic-wallet/commit/3235977fd912ba4bfc90950ea8f337baca009b44))
* **payment-signer:** forward body+headers on 402 retry; add signer.fetch() (0.1.6) ([aa565ed](https://github.com/KeeperHub/agentic-wallet/commit/aa565ed82b21baa921c5aae26c002fe7fd900ba1))
* **payment-signer:** forward workflowSlug to /sign for server-derived payTo binding (0.1.5) ([e3ca34c](https://github.com/KeeperHub/agentic-wallet/commit/e3ca34c80c56ffae2edfbbc9fea49b3a5a81602c))
* **payment-signer:** forward workflowSlug to /sign for server-derived payTo binding (0.1.5) ([6717bde](https://github.com/KeeperHub/agentic-wallet/commit/6717bde488aed4da85a46764f264fdbb69c1ba12))
* paymentHint protocol selection + KEEP-364 regression guards ([250ed56](https://github.com/KeeperHub/agentic-wallet/commit/250ed56c199a12e75434ff99afe2f7b8876b658e))
* **wallet:** disable link + collapse server-approval ask tier (0.1.4) ([475853b](https://github.com/KeeperHub/agentic-wallet/commit/475853bb8a9909bb4ab53d3ebe76e6488b2ce7cd))
* **wallet:** disable link + collapse server-approval ask tier (v0.1.4) ([c35795d](https://github.com/KeeperHub/agentic-wallet/commit/c35795de66020205d0c20e61768d61f3294c9552))


### Bug Fixes

* **payment-signer:** emit spec-compliant x402 v2 PaymentPayload on retry (0.1.7) ([499552e](https://github.com/KeeperHub/agentic-wallet/commit/499552e3b547c8429a8c33a7539664b30f98391a))
* **payment-signer:** emit spec-compliant x402 v2 PaymentPayload on retry (0.1.7) ([597677f](https://github.com/KeeperHub/agentic-wallet/commit/597677f9e5e18b19c68ea50b2300d018f639ef50))
* **payment-signer:** prefer x402 over MPP on dual-challenge 402s ([3912aa1](https://github.com/KeeperHub/agentic-wallet/commit/3912aa19c49e2f04ac9a7d031c1103c7269538f9))
* **payment-signer:** prefer x402 over MPP on dual-challenge 402s ([cc2f854](https://github.com/KeeperHub/agentic-wallet/commit/cc2f854aee824384054510199e298c5769f307c1))
* UAT-caught bugs — contract allowlist + approval-request contract ([21082a7](https://github.com/KeeperHub/agentic-wallet/commit/21082a7af3450070aa0c7af1f8397cd63ed895e6))
* UAT-caught bugs — hook contract addr, approval-request contract, 202 envelope ([0802599](https://github.com/KeeperHub/agentic-wallet/commit/0802599220ce7ded540a4463d56d16a2b2a3a65b))
* use canonical KeeperHub casing in repository URL ([b2e4e0b](https://github.com/KeeperHub/agentic-wallet/commit/b2e4e0b548f4b14eadbc421c199f73415a4a4de6))
* use canonical KeeperHub casing in repository URL (unblocks v0.1.0 publish) ([8141404](https://github.com/KeeperHub/agentic-wallet/commit/8141404cd4cf9e160763d651108f5b44513de8e9))
* write sync skill to skills.sh-expected path ([e55c6b4](https://github.com/KeeperHub/agentic-wallet/commit/e55c6b42f7f0cdd31b60c0a031e2af226a126a1d))
* write sync skill to skills.sh-expected path (skills/&lt;name&gt;/SKILL.md) ([908146e](https://github.com/KeeperHub/agentic-wallet/commit/908146ee0ae66a7fbd1391aa2f1706e06af5a554))
