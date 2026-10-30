# Offer Guard test fixtures (synthetic)
Fictional brand GALI. Approved offer: see offer-spec.json (20% off selected models, paid shipping, until 10.11).

| File | Expected verdict | Why |
|---|---|---|
| ad-01-clean.png | CLEAN | panel matches the spec |
| ad-02-wrong.png | AD_WRONG_REPAIRABLE | panel promises 30% on everything + free shipping; panel is separate from product and logo |
| ad-03-overlap.png | AD_WRONG_UNSAFE | same wrong promise, but the panel overlaps the product → must refuse |
| ad-04-page-wrong.png | PAGE_WRONG | panel matches the spec exactly (like ad-01), but the landing page shows 25% → flag only, never "fix" the ad |
| ad-05-ambiguous.png | AMBIGUOUS | panel says only "הנחה על מוצרים נבחרים" — no percentage, no date → one focused question |
| ad-06-clean-phrasing.png | CLEAN | same offer as the spec in different words ("חיסכון של 20%…", "משלוח לא כלול", "עד 10.11") |
| ad-01-clean-en.png | CLEAN | English twin of ad-01 ("20% off selected models" / "Valid until 10.11 · paid shipping") |
| ad-02-wrong-en.png | AD_WRONG_REPAIRABLE | English twin of ad-02 ("30% off everything" / "+ free shipping · valid until 10.11") |
| ad-03-overlap-en.png | AD_WRONG_UNSAFE | English twin of ad-03 |
| ad-04-page-wrong-en.png | PAGE_WRONG | English twin of ad-04; landing page shows 25% |
| ad-05-ambiguous-en.png | AMBIGUOUS | English twin of ad-05 ("Sale on selected items", no percentage, no date) |
| ad-06-clean-phrasing-en.png | CLEAN | English twin of ad-06 ("Save 20% on selected models" / "Until 10.11 · shipping not included") |

The English set uses the same layout and geometry (logo top right, panel in the same place); only the text and `lang/dir` differ.

Source: `../src/ad.html` template + `scripts/render-fixtures.ts`:

```sh
npm run render:fixtures                  # regenerate all 12 PNGs (Chromium, 1080x1080)
npm run render:fixtures -- --only ad-04  # regenerate a subset (id prefix match)
```

Expected verdicts live ONLY in `tests/fixtures/expected-verdicts.json` and are
never sent to a model. Landing pages per ad come from `fixtures/campaign.json`
(ad-04 points at the wrong page, the rest at the correct page).
