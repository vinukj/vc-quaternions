# Shot direction, display, and classifier TODO

Updated: 2026-11-20

## Priority checklist

| ID | Priority | Work | Status |
|---|---|---|---|
| SHOT-01 | High | Keep the wagon-wheel arrow, selected sector, `#shot-name`, track canvas, report, history, and CSV on one canonical direction geometry. | Done; automated coverage exists. |
| SHOT-02 | Medium | Clear in-session history and restart its numbering. | Done; automated coverage exists. |
| SHOT-03 | Medium | Use direction/sector-aligned stroke-family labels and present specific strokes only as candidates. | Done as a deterministic heuristic; exact stroke recognition remains unverified. |
| SHOT-04 | High | Prefer the dominant swing lobe through its speed peak; exclude later follow-through and split large sample gaps. | Done in browser heuristic; physical calibration remains open. |
| SHOT-05 | High | Improve five-zone direction accuracy using the supplied right-/left-handed recordings. | Data reviewed; no classifier thresholds changed because the recordings lack per-shot ground truth and stance references. |
| SHOT-06 | Medium | Make `direction_consistency_score` reflect directional dispersion, opposing motion, and sample support. | Done; covered by classifier tests, but not benchmarked against labeled physical sessions. |
| SHOT-07 | Medium | Preserve stance quaternion and raw samples in future history/CSV so captures can be replayed in the same relative frame. | Done; history snapshots the stance reference and CSV includes `guard_reference_json`. |
| SHOT-08 | High | Collect independently labeled sessions and validate the five broad zones per player/session before tuning. | Open; requires new labeled captures. |
| SHOT-09 | Medium | Assess whether the recordings support supervised ML. | Assessed; current data is not sufficient for a trustworthy model. |

## Direction goal and current implementation

The first accuracy target is the batter-relative zone: **legside front, legside back, straight, offside front, or offside back**. The detailed sector and likely stroke are secondary. All displayed surfaces now use the same selected geometry so the arrow, highlight, labels, history and CSV cannot silently report different mapped directions.

Shot heading is estimated from the selected sustained angular-motion lobe only through its smoothed speed peak. Later follow-through is excluded from heading; large packet-time gaps split motion into separate bursts. The five-zone label is derived from the same stance-relative geometry, with handedness-aware sector mirroring. This is still an orientation-based heuristic, not a measured bat-tip path or ball trajectory.

Mounting assumption: the screen faces the batter and the charging-port end points toward the handle; sensor +X runs down the bat. The code ignores axial X-roll for field heading and maps sensor Z to screen horizontal and negative sensor Y to screen vertical. Sign calibration with known strokes on the actual board is still required.

## Review of `/Users/vinayjagtap/Downloads/vc-data`

The folder contains five CSV exports and three ODS exports. Non-header record counts are:

| Export | Rows |
|---|---:|
| `cover drive -.csv` | 9 |
| `left hand - mid on.csv` | 12 |
| `left hand - pull.csv` | 7 |
| `off side - square cut.csv` | 11 |
| `right hand - cut.csv` | 11 |
| `right hand - cover.ods` | 9 |
| `right hand - mid on.ods` | 13 |
| `right hand pull.ods` | 12 |
| **Total** | **84** |

These counts do not fully match the supplied rollup (for example, the exports contain 12 left-hand mid-on rows vs 9 reported, 7 left-hand pull rows vs 5 reported, and 12 right-hand pull rows vs 11 reported). The rollup is useful context but cannot be joined reliably to individual exported shots as supplied.

The five CSVs also expose their recorded direction-zone output. These are observed classifier outputs, not verified targets:

| Export | Recorded direction-zone counts |
|---|---|
| `cover drive -.csv` | Offside front 5; Straight 1; Unclear 3 |
| `left hand - mid on.csv` | Offside front 5; Straight 2; Legside front 1; Offside back 1; Unclear 3 |
| `left hand - pull.csv` | Offside front 2; Straight 3; Unclear 2 |
| `off side - square cut.csv` | Offside front 5; Offside back 3; Legside back 1; Behind wicket 2 |
| `right hand - cut.csv` | Behind wicket 6; Straight 2; Offside front 2; Offside back 1 |

All eight exports lack `guard_reference_json`. They contain captured quaternion samples, but without the exact stance quaternion used for each shot, the current stance-relative classifier cannot be replayed faithfully. File names label an intended stroke/session, not a verified direction for every row; the aggregate correct/wrong counts likewise do not identify which specific capture was correct. Therefore no deterministic per-shot confusion matrix or threshold adjustment can be supported by these files alone. Preserve the existing row values; do not infer replacement labels or alter thresholds from the aggregate statistics.

New web history records snapshot the session's stance quaternion into `guard_reference_json`, alongside the full sample window. Use fresh exports after this change to make future capture replay possible. For usable tuning data, also add a per-shot human-verified five-zone label (and optional stroke label), batting hand, player/session ID, actual capture-window and packet timestamps, mount details, and sensor/firmware version. Keep setup, no-shot, and follow-through examples. Evaluate with player/session-held-out splits and report per-zone confusion matrix, precision, recall, and abstention rate.

## Classifier and ML decision

The current deterministic classifier already selects a dominant directional lobe, cuts its direction path at the swing peak, splits large timestamp gaps, and lowers consistency for dispersed or weakly supported movement. These changes are covered by synthetic regressions, not a labeled physical benchmark. Do not claim measured accuracy improvement until a stable labeled capture set is replayed.

Supervised ML may help once there are substantially more complete, independently labeled sessions. The current BLE packet contains orientation quaternions, not raw accelerometer and gyroscope channels. Preserve quaternions and stance for immediate replay; if firmware/data protocol later exposes raw IMU channels, record those too. Include mount/calibration metadata, handedness, player/session identity, and examples of pickup, contact-phase proxy, follow-through, and no-shot motion. Split by player/session to prevent near-duplicate windows leaking between train and test. Compare any model to the current deterministic baseline and keep an explicit unclear/abstain outcome.

## Validation and remaining checks

- Web regression suite: `node --test web/tests/*.test.js` — 122 passed on 2026-11-20.
- Physical testing still needed: known five-zone shots for right- and left-handed stances, then compare live arrow, final zone, selected lobe, history and a fresh CSV.
- The five-zone classifier has not been tuned against the 84 existing rows because per-shot direction labels and the matching stance references are absent.
- Do not interpret heuristic shot candidates as exact stroke recognition; the sensor does not observe the ball, impact, or bat-tip trajectory.
