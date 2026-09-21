## 1. Presentation Model

- [ ] 1.1 Define reader-facing session-type and staffing-state labels from typed schedule data, adding an explicit projection field only if existing data is insufficient
- [ ] 1.2 Render separate Session type and Staffing fields in both current-schedule and preview rows with a responsive stacked layout

## 2. Regression Coverage

- [ ] 2.1 Add rendering tests for fully staffed and understaffed locked center sessions and confirmed classes
- [ ] 2.2 Add a regression proving raw `locked` and `confirmed` lifecycle values are not displayed as staffing outcomes

## 3. Verification

- [ ] 3.1 Update scheduling UI documentation if the projection or documented labels change
- [ ] 3.2 Run focused schedule rendering tests, then run `npm test` and `npm run check`
- [ ] 3.3 Browser-verify current schedule and preview labels at desktop and narrow widths
