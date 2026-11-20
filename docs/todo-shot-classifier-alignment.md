# Shot direction, display, and classifier TODO

Date: 2026-11-17

## Scope and checklist

| ID | Priority | Change / question | Status |
|---|---|---|---|
| SHOT-01 | High | Make the arrow direction, highlighted wagon-wheel sector, `#shot-name`, and `#track-canvas` use one canonical shot geometry. Reproduce Fine Leg vs Square Leg and Cover vs Straight mismatches. | Resolved |
| SHOT-02 | Medium | Add an accessible clear-history control beside “Show history”; clear stored and rendered history so the next session starts fresh. | Resolved |
| SHOT-03 | Medium | Correct the requested naming: show the on-drive-like result as Mid-on, and map the reported lofted straight-drive-like mislabel to Cover Drive where the direction/sector evidence supports Cover. | Resolved |
| SHOT-04 | Medium | Add a direction/sector-specific heuristic vocabulary for the requested stroke candidates (including lofted and behind-wicket options), without presenting direction alone as ground-truth shot recognition. | Resolved |
| SHOT-05 | High | Inspect the supplied right-handed session workbook (EM/EN estimates vs C:F actuals), identify valid observations and errors, and make only evidence-supported classifier/score adjustments. | Resolved |
| SHOT-06 | Medium | Improve `direction_consistency_score` so it reflects directional dispersion, reversals, and sample support rather than only the strongest burst's net/total rotation ratio. | Resolved |
| SHOT-07 | Medium | Assess whether raw-data collection can support an ML classifier; document the required labels, sensor channels, participant diversity, and validation strategy. | Resolved |
| SHOT-08 | High | Add regression tests for direction-to-sector alignment, direction-specific shot labels, clear-history behavior, and workbook-derived cases where stable examples exist. | Resolved |
| SHOT-09 | High | Run the full web test suite and update `docs/bug-fixes.md` with root cause, changes, test evidence, risks, and any remaining hardware/user validation. | Resolved |
| SHOT-10 | High | Estimate shot direction from the dominant swing lobe through its speed peak, exclude late follow-through and split packet gaps, and keep the visible direction/map aligned under the documented display-facing mount. | Resolved in browser heuristic; physical sign calibration pending |

## Reproduction notes

- Reported: an arrow labeled Fine Leg can highlight Square Leg; Cover Drive can highlight Straight Drive.
- Expected: arrow, highlighted field sector, displayed likely stroke, and track canvas all describe the same canonical result.
- Reported UI path: shot completes, then compare wagon-wheel arrow/highlight with `#shot-name` and `#track-canvas`.
- Evidence to capture: existing tests and the provided workbook at
  `/Users/vinayjagtap/Downloads/powerplai-shot-history-2026-11-16T12-39-34-751Z.xlsx`.

## Root-cause / validation log

Root cause: the rendered map independently derived direction/sector from the dominant vector while other UI/report surfaces could retain the classifier's direction, field sector, and stroke family. The renderer also projected the measured endpoint independently of the selected field wedge, so an arrow and highlight could land in neighboring sectors. This made one motion result look like multiple conflicting classifications.

The browser now derives the result-facing labels and sector from one `WagonWheel.shotGeometry()` result, passes that geometry to the map, shot name, accessible label, report, history and CSV primary columns, and snaps the finished-shot arrow to the selected sector angle. Raw classifier fields remain in explicitly named CSV diagnostic columns so disagreement can be investigated rather than silently erased. Clear history removes in-memory records and rendered rows and restarts numbering; CSV remains header-only after clearing.

Direction/sector review of the supplied workbook (worksheet rows 2–8; C:F treated as the user's reference labels, EM:EN as the compared estimate):

| Row | Reference direction / sector | EM sector estimate | Outcome |
|---|---|---|---|
| 2 | Up-right / Cover | cover drive | Match after normalizing to Cover |
| 3 | Up / Straight | straight drive | Match |
| 4 | Left / Square leg | square leg | Match |
| 5 | Left / Square leg | Fine Leg | Mismatch |
| 6 | Left / Square leg | fine leg | Mismatch |
| 7 | Up-right / Cover | point | Mismatch |
| 8 | Down-right / Third man | “Thrid man” | Match after correcting the spelling |

Result: 4/7 sector estimates match (57.1%) after case/wording normalization. The four reference direction-to-sector pairs are internally coherent for a right-handed batter and are now explicit regression cases. No sector thresholds were tuned to these seven examples: the two Fine Leg assignments and the Point assignment conflict with the repeated reference direction/sector pairs, and seven samples are not enough to justify a learned boundary. The EN stroke estimates are heuristic labels and are not independent proof of exact stroke type.

`direction_consistency_score` now measures interval path aligned with the primary direction within the strongest active burst, squares the aligned-path proportion to penalize directional dispersion, discounts sparse support, and returns zero for equally strong opposing bursts. This avoids allowing slow setup/recovery motion elsewhere in the one-second capture to dominate the score.

Stroke candidates are direction/sector-conditioned and explicitly labeled as candidates, not recognized strokes. The set covers Straight, Cover, Point, Third man, Behind batter, Fine leg, Square leg, and Mid-on. Cover and Mid-on labels now use the mapped sector; classifier and map use matching family text. A lofted result only becomes a Cover family when its direction maps to Cover; direction—not the prior “straight drive” wording—controls the family.

ML assessment: feasible as a later supervised classifier, but not responsibly trainable from this workbook alone. The current 17-byte BLE payload is four quaternion float32 values plus one flags byte; it does not expose raw accelerometer/gyroscope channels. For training, collect timestamped complete motion windows (preferably raw gyro + accelerometer as well as orientation), guard/reference pose, sampling gaps, bat/sensor mounting and firmware/calibration metadata, batting hand, player/session identifiers, and independently verified direction plus exact stroke labels. Include no-shot/setup/recovery examples and multiple players/sessions; split evaluation by player/session (not random packets/windows from the same person) and report per-class precision/recall and confusion matrices. Keep the current deterministic heuristic as baseline until the data and held-out evaluation support a model.

Automated validation: `node --test web/tests/*.test.js` — **80/80 tests passed** on 2026-11-17. Physical ESP32 swings and subjective cricket-stroke validation are still required before trusting sector calibration or exact stroke semantics.

## Dominant swing path and mounting frame

Direction now uses the selected sustained directional lobe through its smoothed angular-speed peak. Samples after that peak do not enter the shot heading, so slower late follow-through cannot rotate the arrow or the canonical field sector. A packet-time gap over 220 ms splits bursts; the classifier does not join motion across a likely dropped-data interval. Full-window rotation and peak-speed diagnostics still describe the complete capture.

Mount assumption used by both live pointer and shot classifier: the display faces the batter, the charging-port end points toward the handle, and sensor +X runs down the bat toward that handle. The bat-axis X-roll is ignored for field heading; sensor Z maps to screen horizontal and negative sensor Y maps to screen vertical. This is consistent with the described mount and shared code projection, but signed field directions are not verified from a board drawing alone; confirm them using known-direction swings in the actual mount.

This is an orientation/angular-motion estimate, not the bat-head's physical path or ball-contact trajectory. The BLE stream carries quaternion orientation, not raw accelerometer/gyro channels or a bat-tip position measurement. Regression coverage added for a slower angled follow-through within the same lobe and a 320 ms dropped-packet gap. Full validation: `node --test web/tests/*.test.js` — **90/90 tests passed**; the local `/?airmouse=1` route returned HTTP 200 with the updated direction/mount note. On-device signed-axis calibration remains open.
