# Desk Agent local QA assessment

Date: 2026-10-19. Checkout: 25185020c971936a61e920376155ff38aa69a41b. Node: v22.23.2. Package: 1.0.0.

Outcome: verification incomplete. Automated tests pass, but type checking fails; browser and connected-service end-to-end verification are outstanding. No box created, CRM updated, or /boxes changed, as those actions are outside the authorized local scope.

## Evidence

- tests.log: 10 test files, 194 tests passed; exit 0. Used existing dependencies and an isolated source copy under sandbox with a cleared environment and synthetic tokens. No dependency installation or external service login.
- typecheck.log: npm run typecheck exits 2. TS2345 at src/http/auth.ts:146 and :195 (readonly model arrays passed to a mutable-array parameter); TS7016 at src/http/server.ts:7 (qrcode declaration missing).
- lint-source.log: npm run lint -- src .pi exits 0, 32 warnings, no errors. Initial default lint.log included the assessment source copy, duplicating warnings (64); use lint-source.log for source findings.
- tests-initial.log: initial harness run, 192 passed and 2 failed due to omitted skills-pack/inbox-calendar.json in the isolated copy. Copying the existing fixture resolved both failures. These were harness failures, not app defects.

## Maturity score

Provisional 2/5: functional prototype with automated regression coverage. Rubric: 1 skeleton; 2 working prototype with verification gaps; 3 locally verified release candidate; 4 verified integrations and operational recovery; 5 sustained production evidence. Tests, settings persistence, onboarding UI, deployment files and security documentation support level 2. Failed static checks, weak security-test assertions, and missing browser/integration evidence prevent level 3. This is a local QA judgment, not a production audit.

## Findings and regression plan

1. Resolve the three TypeScript errors and rerun type checking.
2. Replace vacuous self-chat assertions: src/whatsapp/handler.test.ts checks for an exported isSelfChat helper, but src/whatsapp/handler.ts:168 defines it privately; tests return after expect(true). Exercise handleMessage with mocked client identity. Cover owner phone/LID self-chat, outgoing messages to others, groups, incoming non-owner messages and absent owner identity. No authorization bypass is established by this finding; handleMessage also checks the destination identity.
3. Authentication tests duplicate isAuthenticated rather than invoking the production route. Add HTTP tests for missing, wrong and valid query/cookie/bearer tokens against actual handlers and protected endpoints.
4. Browser verification blocked: no browser tool or chromium/google-chrome executable available. Existing HTML/source assertions do not establish rendering, script execution, navigation or accessibility. Run login, unauthorized redirect, wizard QR/AI/identity steps, token acknowledgment, settings save, service empty/error states, and mobile layout in a browser with isolated data and mocked integrations.
5. WhatsApp pairing, provider OAuth, SaaS execution, Docker startup and restart recovery remain unverified. They require a separately authorized isolated integration environment; no real credentials or network integrations were used here.

Only QA artifacts were added. Application source and production configuration were not changed. Sandbox contains copied source and disposable test artifacts; do not commit it as application code.
